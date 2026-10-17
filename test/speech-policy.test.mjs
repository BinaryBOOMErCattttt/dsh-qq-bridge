/**
 * `speech-policy.js` 的契约测试。
 *
 * 这一层决定「群里什么时候会冒出一句话」—— 全项目行为影响最大、也最难在真机上复现的
 * 一段。下面每个用例都从一个**会接话**的基准入参出发，只翻一个字段，断言它把结论翻过来
 * （或者把 `intent` 换掉）：
 *
 *   - 被叫到永远不用抽卡；
 *   - 空消息 / 没有会话记录永远不接；
 *   - C 路（插话）的**四条排除**一条都不能少 —— 尤其是「@ 了别人」；
 *   - 抽卡没中时 `eligible` 仍为 true（调用方要据此 +1 连丢）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideGroupTurn, interjectBatchPrompt, interjectExclusion, interjectLine } from '../speech-policy.js';

/** 「C 路会接」的基准入参：群够热、掷骰必中、有文字、没 @ 别人。 */
const HOT = {
  explicit: false,
  blank: false,
  existing: true,
  followAllowed: false,
  groupHot: true,
  mentionsOthers: false,
  isCommand: false,
  hasText: true,
  selfMessage: false,
  misses: 0,
  chance: 1,
  chanceStep: 0.1,
  chanceMax: 1,
  roll: 0,
};

test('被明确叫到时不需要抽卡：intent = addressed', () => {
  const decision = decideGroupTurn({ ...HOT, explicit: true, groupHot: false, chance: 0, roll: 1 });
  assert.equal(decision.intent, 'addressed');
  assert.equal(decision.reason, 'explicit');
});

test('A 路（一对一窗口里）优先于 C 路：intent = continued', () => {
  const decision = decideGroupTurn({ ...HOT, followAllowed: true });
  assert.equal(decision.intent, 'continued');
  assert.equal(decision.reason, 'follow');
});

test('C 路（群够热）抽中时 intent = interject', () => {
  assert.equal(decideGroupTurn(HOT).intent, 'interject');
});

test('空消息不接，也不消耗抽卡计数（eligible = false）', () => {
  const decision = decideGroupTurn({ ...HOT, blank: true });
  assert.equal(decision.intent, 'none');
  assert.equal(decision.reason, 'blank');
  assert.equal(decision.eligible, false);
});

test('这个群还没有会话记录时不接（闲聊不该凭空建出会话）', () => {
  assert.equal(decideGroupTurn({ ...HOT, existing: false }).reason, 'no-conversation');
});

test('机器人自己发的消息永远不接（兜底）', () => {
  assert.equal(decideGroupTurn({ ...HOT, selfMessage: true }).reason, 'self');
});

test('不够资格（窗口凉了、群也不热）：none，且不算「连丢」', () => {
  const decision = decideGroupTurn({ ...HOT, groupHot: false, followAllowed: false });
  assert.equal(decision.intent, 'none');
  assert.equal(decision.reason, 'not-eligible');
  assert.equal(decision.eligible, false);
});

test('够资格但没抽中：none，但 eligible = true（调用方据此把连丢 +1）', () => {
  const decision = decideGroupTurn({ ...HOT, chance: 0.5, roll: 0.99 });
  assert.equal(decision.intent, 'none');
  assert.equal(decision.reason, 'roll');
  assert.equal(decision.eligible, true);
  assert.equal(decision.chance, 0.5);
});

test('抽卡概率随「连丢」往上涨，掷在两者之间时这一步就翻过来', () => {
  // 起始 0.2、每丢一条 +0.1：连丢两条之后是 0.4。
  const base = { ...HOT, chance: 0.2, chanceStep: 0.1, chanceMax: 0.9, roll: 0.35 };
  assert.equal(decideGroupTurn({ ...base, misses: 0 }).intent, 'none');
  assert.equal(decideGroupTurn({ ...base, misses: 2 }).intent, 'interject');
});

// ---- C 路的四条排除（§7.3）--------------------------------------------------

test('C 路：@ 了别人的消息不接（这是别人在跟别人说话）', () => {
  assert.equal(decideGroupTurn({ ...HOT, mentionsOthers: true }).intent, 'none');
  assert.equal(interjectExclusion({ ...HOT, mentionsOthers: true }), 'mentions-others');
});

test('C 路：命令不接（命令不该被「插话」顺手执行）', () => {
  const decision = decideGroupTurn({ ...HOT, isCommand: true });
  assert.equal(decision.intent, 'none');
  assert.equal(decision.reason, 'command');
});

test('C 路：纯媒体（没有文字）不接 —— 锚点必须是文字', () => {
  const decision = decideGroupTurn({ ...HOT, hasText: false });
  assert.equal(decision.intent, 'none');
  assert.equal(decision.reason, 'media-only');
});

test('C 路的排除不影响 A 路：一对一窗口里 @ 别人的那句仍然不接（A 路自己会挡）', () => {
  // 这里验的是「排除只挂在 C 路上」：followAllowed 由 activeFollowAllows 算好，
  // 那条判据里已经有 mentionsOthers；两边各挡一次，不会互相依赖。
  assert.equal(decideGroupTurn({ ...HOT, followAllowed: true, mentionsOthers: true }).intent, 'continued');
});

// ---- 插话的文案 -------------------------------------------------------------

test('interjectLine：先说「不是叫你的」，再给 SKIP 出口，且不暴露机制', () => {
  const text = interjectLine('kaguya', '晚上吃啥');
  assert.match(text, /群里在聊天，这句不是叫你的/);
  assert.match(text, /kaguya 说：晚上吃啥/);
  assert.match(text, /不想接就只写 SKIP/);
  assert.doesNotMatch(text, /插件|检测到|热度/);
  // 名字里的换行不能伪造出额外一行（不可信输入）。
  assert.doesNotMatch(interjectLine('a\nb', 'x'), /\na\n/);
  // 发不了图的时候不提「只发一张表情」。
  assert.match(interjectLine('kaguya', '晚上吃啥', true), /只发一张表情/);
  assert.doesNotMatch(interjectLine('kaguya', '晚上吃啥', false), /只发一张表情/);
});

test('interjectBatchPrompt：一批多条时只说一次元信息', () => {
  const lines = interjectBatchPrompt(false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /都不是叫你的/);
  assert.match(lines[1], /SKIP/);
});
