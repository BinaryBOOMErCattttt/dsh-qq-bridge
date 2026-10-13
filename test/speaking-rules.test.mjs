/**
 * `speaking-rules.js` 的契约测试。
 *
 * 这些判据原本内联在事件与定时器的回调里，只能从集成测试上观察「某个时刻为什么没说话」。
 * 现在每条都能单独翻动：下面每个用例都从一个**通过**的基准入参出发，只改一个字段，
 * 断言它把结论翻过来 —— 这样「缺一条都不行」不是靠注释声明的，而是被逐条钉住的。
 *
 * 不经过 Harness、不用假 timer、不用假 OneBot。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeFollowAllows,
  activeTurnsLeft,
  batchCap,
  batchScale,
  batchWindow,
  chimeAllows,
  chimeDelay,
  proactiveEligible,
  proactiveSkip,
} from '../speaking-rules.js';

const NOW = 1_700_000_000_000; // 够大，减去几十小时仍是正数（负值在判据里含义不同）

/** 一份「能主动开口」的基准入参：每个用例只翻一个字段。 */
function eligible(overrides = {}) {
  return {
    type: 'group',
    hasQueuedBatch: false,
    busy: false,
    lastActiveAt: NOW - 60 * 60 * 1000, // 一小时前有人说过话
    lastBotSpeakAt: 0,
    lastProactiveAt: 0,
    todayCount: 0,
    now: NOW,
    idleMs: 45 * 60 * 1000,
    freshMs: 24 * 60 * 60 * 1000,
    gapMs: 2 * 60 * 60 * 1000,
    dailyMax: 4,
    ...overrides,
  };
}

test('主动说话：基准入参能开口，每条闸门单独翻动都会拦住', () => {
  assert.equal(proactiveEligible(eligible()), true, '基准应当通过');

  assert.equal(proactiveEligible(eligible({ type: 'private' })), false, '1 只群聊');
  assert.equal(proactiveEligible(eligible({ hasQueuedBatch: true })), false, '2 有待投的批次');
  assert.equal(proactiveEligible(eligible({ busy: true })), false, '2 有 turn 在飞');
  // lastActiveAt 为 0 = 这个群从来没人说过话（会话可能只是出站工具建出来的壳）。
  assert.equal(proactiveEligible(eligible({ lastActiveAt: 0 })), false, '3 没有可搭的话头');
  // now 比 lastActiveAt 还早：时钟回拨 / 事件乱序时不能当成「安静了很久」。
  assert.equal(proactiveEligible(eligible({ now: NOW - 2 * 60 * 60 * 1000 })), false, '3 时刻比说话还早');
  assert.equal(proactiveEligible(eligible({ lastBotSpeakAt: NOW - 60 * 60 * 1000 })), false, '4 独白：我上一条之后没人接');
  assert.equal(proactiveEligible(eligible({ lastActiveAt: NOW - 45 * 60 * 1000 + 1 })), false, '5 安静得还不够');
  assert.equal(proactiveEligible(eligible({ lastActiveAt: NOW - 25 * 60 * 60 * 1000 })), false, '6 太久了，不诈尸');
  assert.equal(proactiveEligible(eligible({ lastProactiveAt: NOW - 60 * 60 * 1000 })), false, '7 距上次主动说话太近');
  assert.equal(proactiveEligible(eligible({ todayCount: 4 })), false, '8 当天额度用完');
});

test('主动说话：两个「0 = 不限」的配置要保住含义', () => {
  assert.equal(proactiveEligible(eligible({ lastActiveAt: NOW - 100 * 24 * 60 * 60 * 1000, freshMs: 0 })), true, 'freshMs = 0 表示不限制多久没动静');
  assert.equal(proactiveEligible(eligible({ lastProactiveAt: NOW - 1, gapMs: 0 })), true, 'gapMs = 0 表示不限间隔');
  assert.equal(proactiveEligible(eligible({ todayCount: 0, dailyMax: 0 })), false, 'dailyMax = 0 表示一次都不主动说');
});

test('主动说话：边界的相等关系（安静够久 / 距上次够远算通过）', () => {
  // 「已经安静了整整 idleMs」应当算够久了（判据是 `< idleMs` 才拦）。
  assert.equal(proactiveEligible(eligible({ lastActiveAt: NOW - 45 * 60 * 1000 })), true);
  assert.equal(proactiveEligible(eligible({ lastProactiveAt: NOW - 2 * 60 * 60 * 1000 })), true);
  // 独白是 `>=`：我说完话之后恰好没人接（两个时刻相等）也该算独白。
  assert.equal(proactiveEligible(eligible({ lastBotSpeakAt: NOW - 60 * 60 * 1000, lastActiveAt: NOW - 60 * 60 * 1000 })), false);
});

test('SKIP：第一行以 skip 开头就算「不说」，解释半句一起丢掉', () => {
  for (const text of ['SKIP', 'skip', '  SKIP  ', '（SKIP）', '[SKIP] 没什么可说的', '(（skip', '\n\nSKIP（今天不想说）']) {
    assert.equal(proactiveSkip(text), true, `应当判成 SKIP: ${JSON.stringify(text)}`);
  }
});

test('SKIP：别把正文吞掉（词边界 / 位置）', () => {
  // 词边界：`skipping` 是正文，不是决定。
  assert.equal(proactiveSkip('skipping 一下这个词'), false);
  // 不在开头：只是提到这个词，不是在解释内部决定。
  assert.equal(proactiveSkip('我不 SKIP 了，我说两句'), false);
  assert.equal(proactiveSkip(''), false);
  assert.equal(proactiveSkip(undefined), false);
  // 只看**第一行**：第二行的 SKIP 不算（那多半是正文的一部分）。
  assert.equal(proactiveSkip('今天想说的很多\nSKIP'), false);
});

test('免 @ 轮数：0 = 不限，够数就为止', () => {
  assert.equal(activeTurnsLeft(0, 999), true, '上限 0 = 不限');
  assert.equal(activeTurnsLeft(10, 9), true);
  assert.equal(activeTurnsLeft(10, 10), false);
  assert.equal(activeTurnsLeft(10, 11), false);
});

/** 一份「能免 @ 接话」的基准入参。 */
function follow(overrides = {}) {
  return {
    enabled: true,
    windowMs: 60 * 1000,
    type: 'group',
    speakerId: 'u1',
    userId: 'u1',
    activeUntil: NOW + 1000,
    turnsLeft: true,
    interposeOthers: 8,
    interposeSnapshot: 7, // 当前这条自己已经把序号 +1，所以 8 = 快照 + 1 是「紧跟着」
    mentionsOthers: false,
    now: NOW,
    ...overrides,
  };
}

test('免 @ 接话：基准入参通过，每条判据单独翻动都会拦住', () => {
  assert.equal(activeFollowAllows(follow()), true, '基准应当通过');

  assert.equal(activeFollowAllows(follow({ enabled: false })), false, '1 activeFollow 关着');
  assert.equal(activeFollowAllows(follow({ windowMs: 0 })), false, '1 窗口关着');
  assert.equal(activeFollowAllows(follow({ type: 'private' })), false, '2 私聊不需要免 @');
  assert.equal(activeFollowAllows(follow({ speakerId: 'u2' })), false, '3 不是正在跟它聊的那个人');
  assert.equal(activeFollowAllows(follow({ activeUntil: NOW })), false, '4 窗口过期了');
  assert.equal(activeFollowAllows(follow({ turnsLeft: false })), false, '5 免 @ 轮数用完');
  assert.equal(activeFollowAllows(follow({ interposeOthers: 9 })), false, '6 中间有人插过话');
  assert.equal(activeFollowAllows(follow({ mentionsOthers: true })), false, '7 这句 @ 了别人');
});

test('免 @ 接话：「紧跟着的下一条」这个等式是刻意留的容差', () => {
  // 当前这条消息自己已经把插话序号 +1，所以合法值恰好是快照 + 1；再大就是中间隔了人。
  assert.equal(activeFollowAllows(follow({ interposeOthers: 8 })), true, '快照 + 1 通过');
  assert.equal(activeFollowAllows(follow({ interposeOthers: 9 })), false, '快照 + 2 拦住');
  // 别人一句话都没说过（快照 0、当前这条算第 1 条）也应当通过。
  assert.equal(activeFollowAllows(follow({ interposeOthers: 1, interposeSnapshot: 0 })), true);
});

/** 一份「能补一句」的基准入参。 */
function chime(overrides = {}) {
  return {
    seqMatches: true,
    proactiveEnabled: true,
    now: NOW,
    activeUntil: NOW + 1000,
    hasQueuedBatch: false,
    busy: false,
    chimeCount: 0,
    chimeMax: 1,
    chimeToday: 0,
    chimeDailyMax: 12,
    lastBotSpeakAt: NOW - 5000, // 我回过
    lastActiveAt: NOW - 20_000, // 对方没接（所以 lastBotSpeakAt 更晚）
    type: 'group',
    interposeOthers: 7,
    interposeSnapshot: 7,
    chance: 1,
    roll: 0,
    ...overrides,
  };
}

test('补一句：基准入参通过，每条判据单独翻动都会拦住', () => {
  assert.equal(chimeAllows(chime()), true, '基准应当通过');

  assert.equal(chimeAllows(chime({ seqMatches: false })), false, '1 编号对不上（已被取代）');
  assert.equal(chimeAllows(chime({ proactiveEnabled: false })), false, '2 proactive 关着');
  assert.equal(chimeAllows(chime({ activeUntil: NOW })), false, '3 窗口不热了');
  assert.equal(chimeAllows(chime({ hasQueuedBatch: true })), false, '4 有待投批次');
  assert.equal(chimeAllows(chime({ busy: true })), false, '4 有 turn 在飞');
  assert.equal(chimeAllows(chime({ chimeCount: 1 })), false, '5 这一句之后已经补过了');
  assert.equal(chimeAllows(chime({ chimeToday: 12 })), false, '6 当天超量');
  // 7 关键那条：对方**没接**（我说完话之后群里再没人说话）才补；有人接的话那条消息
  // 自己会走正常回复，而这个定时器一到就会被作废。
  assert.equal(chimeAllows(chime({ lastBotSpeakAt: NOW - 20_000, lastActiveAt: NOW - 5000 })), false, '7 对方接了，不用我补');
  assert.equal(chimeAllows(chime({ interposeOthers: 8 })), false, '8 群里中间有人插话');
  assert.equal(chimeAllows(chime({ chance: 0 })), false, '9 概率是 0');
  assert.equal(chimeAllows(chime({ chance: 0.5, roll: 0.5 })), false, '9 没掷中（roll 不小于 chance）');
  assert.equal(chimeAllows(chime({ chance: 0.5, roll: 0.49 })), true, '9 掷中');
});

test('补一句：两个「0 = 不限」的上限与私聊不看的判据', () => {
  assert.equal(chimeAllows(chime({ chimeMax: 0, chimeCount: 99 })), true, 'chimeMax = 0 不限');
  assert.equal(chimeAllows(chime({ chimeDailyMax: 0, chimeToday: 99 })), true, 'chimeDailyMax = 0 不限');
  // 私聊没有「群里插话」这回事，序号判据不参与。
  assert.equal(chimeAllows(chime({ type: 'private', interposeOthers: 999, interposeSnapshot: 0 })), true);
});

test('补一句的延迟：抖动上下界与 500ms 地板', () => {
  assert.equal(chimeDelay(20_000, 0, 0.5), 20_000, '抖动为 0 时就是固定延迟');
  assert.equal(chimeDelay(20_000, 0.4, 0), 12_000, 'roll = 0 → 下界');
  assert.equal(chimeDelay(20_000, 0.4, 1), 28_000, 'roll = 1 → 上界');
  // 掐着表整点补一句比不补还像机器人，所以下限是刻意的。
  assert.equal(chimeDelay(100, 0, 0.5), 500);
});

test('倾听倍数：只有「聊起来的群」才放大', () => {
  assert.equal(batchScale('private', true, 2), 1, '私聊不放大');
  assert.equal(batchScale('group', false, 2), 1, '群没聊热不放大');
  assert.equal(batchScale('group', true, 2), 2);
});

test('攒批窗口与上限：0 = 关闭，两处同倍放大', () => {
  assert.equal(batchWindow(0, 2), 0, '窗口 0 = 关闭攒批（放大也还是 0）');
  assert.equal(batchWindow(1200, 1), 1200);
  assert.equal(batchWindow(1200, 2), 2400);
  // 上限比窗口小时按窗口算（否则「最多等」比「先等一会」还短，没有意义）。
  assert.equal(batchCap(5000, 1200, 1), 5000);
  assert.equal(batchCap(0, 1200, 1), 1200, '上限关着时退化成窗口');
  assert.equal(batchCap(5000, 2400, 2), 10_000, '与窗口同倍放大');
  assert.equal(batchCap(500, 2400, 2), 2400, '放大后（1000）仍小于窗口就取窗口');
});
