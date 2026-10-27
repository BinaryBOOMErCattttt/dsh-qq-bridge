/**
 * 话题记忆（`topics.js`）的纯函数与账本契约。
 *
 * 这里不经过 Harness：喂一份假的 `gameData` / `save` 就能验「什么时候降档、降几档、
 * 常驻摘要取哪几种、TOPICS.md 写成什么样」。端到端（模型登记 → 下一轮提示词里出现）
 * 在 `test/bridge-topics.test.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOPIC_BRIEF_MAX,
  TOPIC_LABEL,
  TOPIC_MAX,
  TOPIC_TIERS,
  createTopicStore,
  decayTopics,
  normalizeTier,
  topicDecayTurns,
} from '../topics.js';

const CONVERSATION = { key: 'group:100000001', type: 'group', name: '测试群' };

/** 一份最小账本：`data` 就是 chat-state 里的 topics 段。 */
function fixture({ topics = {}, mode = 'full', save = () => {} } = {}) {
  const data = { ...topics };
  const store = createTopicStore({
    gameData: (name) => {
      assert.equal(name, 'topics');
      return data;
    },
    save,
    appModeOf: () => mode,
    cwd: undefined,
  });
  return { data, store };
}

test('topicDecayTurns：简洁 6 轮、完整 / 斗图 15 轮', () => {
  assert.equal(topicDecayTurns('simple'), 6);
  assert.equal(topicDecayTurns('full'), 15);
  assert.equal(topicDecayTurns('sticker'), 15);
  assert.equal(topicDecayTurns(undefined), 15);
});

test('normalizeTier：认得出的大小写都收，认不出的一律 medium', () => {
  for (const tier of TOPIC_TIERS) assert.equal(normalizeTier(tier.toUpperCase()), tier);
  assert.equal(normalizeTier('中'), 'medium');
  assert.equal(normalizeTier(''), 'medium');
  assert.equal(normalizeTier(undefined), 'medium');
  // 四档的中文名都要有 —— 回复与 TOPICS.md 直接用这个。
  for (const tier of TOPIC_TIERS) assert.ok(TOPIC_LABEL[tier].length > 0, tier);
});

test('decayTopics：到窗口才降一档，降完重新起算；冷区不再降', () => {
  const list = [
    { topic: '刚提过', tier: 'high', lastRound: 9 },
    { topic: '凉了', tier: 'high', lastRound: 0 },
    { topic: '冷区', tier: 'cold', lastRound: 0 },
  ];
  // 第 10 轮：只有 lastRound=0 的那条满 10 轮，降一档并重新起算到 10。
  assert.equal(decayTopics(list, 10, 10), true);
  assert.equal(list[0].tier, 'high', '刚提过的不动');
  assert.equal(list[1].tier, 'medium');
  assert.equal(list[1].lastRound, 10, '降档后重新起算，避免一轮连降到底');
  assert.equal(list[2].tier, 'cold', '冷区不再降');
  // 同一轮再跑一次：没有新变化。
  assert.equal(decayTopics(list, 10, 10), false);
  // 再等 10 轮：medium → low。
  assert.equal(decayTopics(list, 20, 10), true);
  assert.equal(list[1].tier, 'low');
});

test('decayTopics：窗口至少 1 轮，坏条目被跳过', () => {
  const list = [{ topic: 'a', tier: 'high', lastRound: 0 }, null, { tier: 'high', lastRound: 0 }];
  assert.equal(decayTopics(list, 1, 0), true);
  assert.equal(list[0].tier, 'medium');
  assert.equal(list[2].tier, 'medium');
  assert.equal(decayTopics(undefined, 5, 5), false, '非数组也不炸');
});

test('set：新建 / 更新 / 排序 / 上限，落盘由调用方 save', () => {
  let saved = 0;
  const { data, store } = fixture({ save: () => { saved += 1; } });
  const first = store.set(CONVERSATION, { topic: '搬家', tier: 'high', summary: '周六搬' });
  assert.equal(first.tier, 'high');
  assert.equal(first.label, '常驻');
  assert.equal(saved, 1, '每次登记都要标脏');

  // 同名更新：改档位与摘要，不新增一条。
  store.set(CONVERSATION, { topic: '搬家', tier: 'low', summary: '搬完了' });
  assert.equal(data[CONVERSATION.key].length, 1);
  assert.equal(data[CONVERSATION.key][0].tier, 'low');
  assert.equal(data[CONVERSATION.key][0].summary, '搬完了');

  // 认不出的档位按 medium，空的 summary 不覆盖已有的。
  store.set(CONVERSATION, { topic: '搬家', tier: '随便', summary: '' });
  assert.equal(data[CONVERSATION.key][0].tier, 'medium');
  assert.equal(data[CONVERSATION.key][0].summary, '搬完了');

  // 空名字直接拒绝：一条没有名字的话题在提示词里只会是「- ：」。
  assert.throws(() => store.set(CONVERSATION, { topic: '   ', tier: 'high' }), /话题名不能为空/);
});

test('set：超过上限丢最久没被提到的那条', () => {
  const topics = { [CONVERSATION.key]: [] };
  for (let index = 0; index < TOPIC_MAX; index += 1) {
    topics[CONVERSATION.key].push({ topic: `话题${index}`, tier: 'medium', summary: '', lastRound: index });
  }
  const { data, store } = fixture({ topics });
  // 真实运行时 conversation.topicRound 就是「最高轮次」（每次 decay 都 +1），
  // 所以新登记的那条 lastRound 一定是最新的 —— 它排最前、被挤掉的是最久的。
  const conversation = { ...CONVERSATION, topicRound: TOPIC_MAX };
  store.set(conversation, { topic: '新话题', tier: 'high', summary: '刚登记的' });
  const list = data[CONVERSATION.key];
  assert.equal(list.length, TOPIC_MAX, '总数不涨');
  assert.equal(list[0].topic, '新话题', '最近登记的排最前');
  assert.ok(!list.some((topic) => topic.topic === '话题0'), '最久没被提到的那条被挤掉');
});

test('briefLines：只取 high、最多 6 条、没有摘要给兜底文案', () => {
  const topics = {
    [CONVERSATION.key]: [
      { topic: 'A', tier: 'high', summary: '一句话', lastRound: 1 },
      { topic: 'B', tier: 'medium', summary: '按需', lastRound: 2 },
      { topic: 'C', tier: 'high', summary: '', lastRound: 3 },
    ],
  };
  const { store } = fixture({ topics });
  const lines = store.briefLines(CONVERSATION);
  assert.deepEqual(lines, ['- A：一句话', '- C：（常驻话题）']);
  // 再多几条 high 也只有一个上限。
  const many = { [CONVERSATION.key]: Array.from({ length: 10 }, (_item, index) => ({ topic: `T${index}`, tier: 'high', summary: 'x' })) };
  assert.equal(fixture({ topics: many }).store.briefLines(CONVERSATION).length, TOPIC_BRIEF_MAX);
});

test('decay：每次有人说话轮次 +1，只有真的降档才写盘', () => {
  let saved = 0;
  const topics = { [CONVERSATION.key]: [{ topic: 'A', tier: 'high', summary: '', lastRound: 0 }] };
  const { data, store } = fixture({ topics, mode: 'simple', save: () => { saved += 1; } });
  const conversation = { ...CONVERSATION };
  // 简洁模式窗口是 6：前 5 次不降。
  for (let round = 1; round <= 5; round += 1) {
    store.decay(conversation);
    assert.equal(conversation.topicRound, round);
  }
  assert.equal(data[CONVERSATION.key][0].tier, 'high');
  assert.equal(saved, 0, '没降档就不写盘');
  store.decay(conversation);
  assert.equal(data[CONVERSATION.key][0].tier, 'medium');
  assert.equal(saved, 1);
});

test('writeFile：把所有会话写成一份人可读的 TOPICS.md', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-topics-'));
  const topics = {
    'group:1': [{ topic: '搬家', tier: 'high', summary: '周六搬', lastRound: 3 }],
    'private:2': [{ topic: '考试', tier: 'cold', summary: '', lastRound: 9 }],
    'group:3': [],
  };
  const store = createTopicStore({ gameData: () => topics, save: () => {}, appModeOf: () => 'full', cwd });
  await store.writeFile();
  const text = await readFile(join(cwd, 'data', 'TOPICS.md'), 'utf8');
  assert.match(text, /# 话题记忆/);
  assert.match(text, /模式轮数：15/);
  assert.match(text, /## group:1/);
  assert.match(text, /\| 搬家 \| 常驻 \| 周六搬 \| 3 \|/);
  assert.match(text, /## private:2/);
  assert.match(text, /\| 考试 \| 冷区 \|  \| 9 \|/);
  // 没有话题的会话不写空表头。
  assert.doesNotMatch(text, /## group:3/);
});
