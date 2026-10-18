/**
 * `memory-select.js` 的契约测试 —— 长期记忆 v2 的**检索、打包、滚档与逐条写入**。
 *
 * 这些用例对应 docs/memory.md「长期记忆」里的契约。它们刻意只走纯函数：
 * 同样的记录 + 同样的查询 → 同样的输出，所以这里不需要假磁盘、假 Harness。
 *
 * 重点不是「能不能选出来」，而是几条**失败方向**：
 *   - 文件后面的条目不能因为「在文件里靠后」就永远看不见；
 *   - 没有命中时不能从文件头截断；
 *   - 私聊的记录不能出现在别的会话的候选集里（不是降权，是根本不进）；
 *   - 滚档只能减不能增，且绝不往热层写指针行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  archiveLineOf,
  archivePlan,
  parseMemoryDoc,
  parsePeopleDoc,
  personRow,
  queryTokens,
  recordsFromCognition,
  recordsFromStickers,
  renderMemoryBlock,
  removeMemoryRow,
  removePersonRow,
  upsertMemoryRow,
  upsertPersonRow,
  visibleTo,
} from '../memory-select.js';
import { parseCognition } from '../cognition.js';

/** 一份典型的热层：人物 / 惯例 / 在追 / 事实。 */
const MEMORY = `# 群 709563326 的长期记忆

## 人
- kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本｜首见 2026-10-12｜置信：确认
- iroha｜群友，爱看展｜首见 2026-10-13

## 惯例与偏好
- 周五固定开黑｜晚上八点，别迟到

## 在追
- 十月新番｜每周三更新｜到期 2026-12-31

## 事实与事件
- 上次团建｜去了海边，风很大｜首见 2026-09-20
`;

/** 一条最小可用的记录（只为渲染与打分服务）。 */
function fakeRecord(index, over = {}) {
  const section = over.section ?? '事实与事件';
  const kind = over.kind ?? 'fact';
  const topic = over.topic ?? `事实${index}`;
  return {
    id: over.id ?? `${kind}:group:1:${section}:${topic}`,
    file: over.file ?? 'MEMORY.md',
    line: over.line ?? index + 1,
    raw: `- ${topic}｜${over.body ?? '一句话'}`,
    section,
    kind,
    scope: over.scope ?? 'group:1',
    text: over.text ?? `${topic}：${over.body ?? '一句话'}`,
    keys: over.keys ?? [topic],
    topic,
    name: over.name ?? topic,
    qq: over.qq ?? '',
    aliases: over.aliases ?? [],
    variants: over.variants ?? [],
    detail: over.detail ?? '',
    date: over.date ?? '',
    confidence: over.confidence ?? '确认',
    expiresAt: over.expiresAt,
    firstSeen: undefined,
    lastSeen: undefined,
    hits: over.hits ?? 0,
    pinned: over.pinned ?? kind === 'person',
    order: over.order ?? index,
  };
}

function block(records, query, over = {}) {
  return renderMemoryBlock({
    records,
    query,
    scope: 'group:1',
    config: { promptChars: 6000, recallK: 12, peopleMax: 20, vocabHint: true, ...(over.config ?? {}) },
    ...over,
  });
}

/** 把一份热层文本解析成记录，再拼上认知库。 */
function recordsOf(markdown = MEMORY, cognition = '') {
  const records = parseMemoryDoc(markdown, { file: 'conversations/group-1/MEMORY.md', scope: 'group:1' }).records;
  const memes = recordsFromCognition(parseCognition(cognition).entries);
  return [...records, ...memes];
}

test('解析：一节一条，人物按 QQ / 名字 / 别名建键，日期与置信按内容认', () => {
  const { records, warnings } = parseMemoryDoc(MEMORY, { file: 'MEMORY.md', scope: 'group:1' });
  assert.deepEqual(warnings, []);
  assert.equal(records.length, 5);
  const person = records[0];
  assert.equal(person.kind, 'person');
  assert.equal(person.name, 'kaguya');
  assert.equal(person.qq, '100000001');
  assert.deepEqual(person.aliases, ['soyo']);
  assert.ok(person.keys.includes('soyo'));
  assert.equal(person.pinned, true);
  assert.match(person.text, /^kaguya（QQ 100000001）：群主/);
  assert.equal(records[1].date, '2026-10-13');
  assert.equal(records[3].expiresAt > 0, true);
  assert.equal(records[4].date, '2026-09-20');
});

test('解析：无日期条目不会消失，认不出的行只记 warn 不进索引', () => {
  const { records, warnings } = parseMemoryDoc('## 事实与事件\n- 没有日期的一句话\n- ｜只有正文\n');
  assert.equal(records.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /没有主题/);
});

test('无日期老梗回归：消息里出现写法 → 不看日期也进提示词', () => {
  // 34 条里有 17 条没有日期，旧实现把它们当成「最旧」，永远进不了热梗段。
  const lines = [];
  for (let index = 0; index < 30; index += 1) lines.push(`- 新梗${index}｜刚学的｜2026-10-${String((index % 28) + 1).padStart(2, '0')}`);
  lines.push('- 老说法｜很久以前学的，从来没写日期');
  const records = recordsFromCognition(parseCognition(`## 黑话与缩写\n${lines.join('\n')}\n`).entries);
  const rendered = block(records, '他又来那句老说法了', { config: { promptChars: 6000 } });
  assert.match(rendered.text, /老说法 —— 很久以前学的/);
  assert.ok(rendered.picked.some((record) => record.topic === '老说法'));
});

test('梗命中变体：消息里出现变体 → 命中同一条，并带上「怎么用」', () => {
  const records = recordsOf(MEMORY, '## 谐音与变体\n- 绷不住了（变体：蚌埠住了 / 绷不住）｜忍不住笑了｜有人发离谱东西时｜2026-10-12\n');
  const rendered = block(records, '蚌埠住了');
  assert.match(rendered.text, /绷不住了（变体：蚌埠住了 \/ 绷不住） —— 忍不住笑了；怎么用：有人发离谱东西时/);
  assert.ok(rendered.picked.some((record) => record.kind === 'meme'));
});

test('存疑的梗不进候选，但写法仍进词汇表：猜测不该被当成事实，模型得知道它存在', () => {
  const records = recordsOf(MEMORY, '## 黑话与缩写\n- 存疑梗｜大概是这个意思｜2026-10-01｜置信：存疑\n');
  const rendered = block(records, '存疑梗');
  assert.doesNotMatch(rendered.text, /存疑梗 —— /, '存疑条目的含义不能进提示词');
  assert.match(rendered.text, /词汇表.*存疑梗/);
  assert.equal(rendered.picked.some((record) => record.topic === '存疑梗'), false);
});

test('预算：相关条目在、无关条目不在、人物在、文件头几条无关的不在', () => {
  const records = [fakeRecord(0, { topic: 'kaguya', kind: 'person', section: '人', name: 'kaguya', qq: '100000001', text: 'kaguya（QQ 100000001）：群主' })];
  for (let index = 1; index <= 100; index += 1) {
    records.push(fakeRecord(index, {
      topic: `无关${index}`,
      body: '这是一条和当前话题毫无关系的普通事实，用来把预算占满'.repeat(2),
      text: `无关${index}：这是一条和当前话题毫无关系的普通事实，用来把预算占满`,
    }));
  }
  records.push(fakeRecord(101, { topic: '海边团建', body: '风很大', text: '海边团建：风很大' }));
  const rendered = block(records, '还记得上次海边团建吗', { focus: ['kaguya'], config: { promptChars: 900 } });
  assert.match(rendered.text, /海边团建：风很大/);
  assert.match(rendered.text, /kaguya（QQ 100000001）：群主/, '说话人的人物记录必进');
  assert.doesNotMatch(rendered.text, /无关1：/, '文件头那几条无关的不该靠「在前面」挤进提示词');
  assert.ok(rendered.text.length <= 900 + 1, `预算必须守住，实际 ${rendered.text.length}`);
});

test('兜底：没有任何命中时按 pinned / salience / 最近取，绝不取文件头', () => {
  const records = [];
  for (let index = 0; index < 40; index += 1) records.push(fakeRecord(index, { topic: `老${index}`, text: `老${index}：一条事实` }));
  // 文件最后一条命中最多、也是最新的；前面那些只是「在文件里靠前」。
  records.push(fakeRecord(40, { topic: '最近的事实', text: '最近的事实：刚刚发生', hits: 9 }));
  const rendered = block(records, '完全不相干的查询', { config: { promptChars: 400 } });
  assert.match(rendered.text, /最近的事实/);
  assert.doesNotMatch(rendered.text, /老0：/, '没有命中时不能退回「文件开头」');
});

test('人物全量注入：说话人都能进，受 memoryPeopleMax 约束', () => {
  const records = [];
  for (let index = 0; index < 30; index += 1) {
    records.push(fakeRecord(index, { topic: `人${index}`, kind: 'person', section: '人', name: `人${index}`, text: `人${index}：某个群友` }));
  }
  const rendered = block(records, '', { focus: ['人3', '人7'], config: { peopleMax: 3 } });
  const people = rendered.sections.find((section) => section.name === '人');
  assert.equal(people.lines.length, 3);
  assert.match(rendered.text, /人3：某个群友/);
  assert.match(rendered.text, /人7：某个群友/);
});

test('隐私：private:<qq> 记录不出现在群提示词里，group 之间也互相隔离', () => {
  const records = [
    fakeRecord(0, { scope: 'global', topic: '公共梗', kind: 'meme', text: '公共梗 —— 谁都知道' }),
    fakeRecord(1, { scope: 'private:100000002', topic: '私聊秘密', text: '私聊秘密：只在这个私聊成立' }),
    fakeRecord(2, { scope: 'group:2', topic: '另一个群的暗号', text: '另一个群的暗号：只在群 2 成立' }),
    fakeRecord(3, { scope: 'group:1', topic: '本群约定', text: '本群约定：周五开黑' }),
  ];
  const rendered = block(records, '私聊秘密 另一个群的暗号 本群约定');
  assert.match(rendered.text, /本群约定/);
  assert.match(rendered.text, /公共梗/);
  assert.doesNotMatch(rendered.text, /私聊秘密/);
  assert.doesNotMatch(rendered.text, /另一个群的暗号/);
  // 换一个私聊看：它自己那条可见，群的不可见。
  const privateBlock = renderMemoryBlock({ records, query: '私聊秘密 本群约定', scope: 'private:100000002' });
  assert.match(privateBlock.text, /私聊秘密/);
  assert.doesNotMatch(privateBlock.text, /本群约定/);
  assert.equal(visibleTo(records[1], 'group:1'), false);
  assert.equal(visibleTo(records[1], 'private:100000002'), true);
});

test('词汇表：给出全部梗的写法（含变体），不给含义；关掉时整行消失', () => {
  const records = recordsOf(MEMORY, '## 黑话与缩写\n- 典｜讽刺经典操作\n- 绷不住了（变体：蚌埠住了）｜忍不住笑了\n');
  const rendered = block(records, '随便说点什么');
  assert.match(rendered.text, /词汇表/);
  assert.match(rendered.text, /典、绷不住了、蚌埠住了/);
  const off = block(records, '随便说点什么', { config: { vocabHint: false } });
  assert.doesNotMatch(off.text, /词汇表/);
});

test('出处：每条记录都带文件与行号，模型能自己 read 深挖', () => {
  const records = recordsOf(MEMORY, '## 黑话与缩写\n- 典｜讽刺经典操作\n');
  const rendered = block(records, '典');
  assert.match(rendered.text, /MEMORY\.md#L4/);
  assert.match(rendered.text, /MEMORY\.md#L8/);
  assert.match(rendered.text, /COGNITION\.md#L2/);
});

test('索引：INDEX.md 原样放进「全局索引」，不参与打分', () => {
  const rendered = renderMemoryBlock({
    records: recordsOf(MEMORY),
    query: '在吗',
    scope: 'group:1',
    indexText: '- kaguya：群主，周六常组织打本',
    config: { promptChars: 6000 },
  });
  assert.match(rendered.text, /### 全局索引（INDEX.md）/);
  assert.match(rendered.text, /kaguya：群主/);
});

test('归档聚合行：只现算，长度恒定，不随滚档次数增长', () => {
  const one = archiveLineOf(['2026-10']);
  const many = archiveLineOf(['2025-01', '2025-02', '2026-10']);
  assert.match(one, /archive\/ 下 1 个文件/);
  assert.match(many, /archive\/ 下 3 个文件（2025-01 … 2026-10）/);
  assert.ok(many.length - one.length < 20);
  assert.equal(archiveLineOf([]), '');
});

test('queryTokens：中文 bigram、短查询退化成 unigram、英文按词', () => {
  assert.deepEqual(new Set(queryTokens('海边团建')), new Set(['海边', '边团', '团建']));
  assert.deepEqual(new Set(queryTokens('典')), new Set(['典']));
  assert.deepEqual(new Set(queryTokens('ab')), new Set(['ab']));
  assert.ok(queryTokens('kaguya 在吗').includes('kaguya'));
});

test('upsertMemoryRow：同主题原地替换，别的行一字不动；不同名不重复', () => {
  const first = upsertMemoryRow('## 事实与事件\n- 团建｜去了海边\n- 旧事｜一句话\n', {
    topic: '团建',
    text: '去了山里',
    section: '事实与事件',
    date: '2026-10-18',
  });
  assert.equal(first.replaced, true);
  assert.match(first.text, /- 团建｜去了山里｜首见 2026-10-18｜置信：确认/);
  assert.match(first.text, /- 旧事｜一句话/);
  const twice = upsertMemoryRow(first.text, { topic: '团建', text: '又换了个说法', section: '事实与事件' });
  assert.equal(parseMemoryDoc(twice.text).records.length, 2, 'upsert 不能产生重复条目');
  assert.equal(removeMemoryRow(twice.text, '团建').removed, true);
});

test('upsertPersonRow / parsePeopleDoc：QQ 号是主键，别名可查，改名不丢字段', () => {
  const added = upsertPersonRow('', { name: 'kaguya', qq: '100000001', aliases: ['soyo'], note: '群主', date: '2026-10-12' });
  assert.equal(added.section, '人物');
  assert.match(added.text, /kaguya（QQ 100000001）（别名：soyo）｜群主/);
  const parsed = parsePeopleDoc(added.text);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].kind, 'person');
  assert.equal(parsed.records[0].pinned, true);
  // 按 QQ 号找得到（名字换了也不重复）。
  const renamed = upsertPersonRow(added.text, { name: '辉夜', qq: '100000001', note: '群主，周六开黑' });
  assert.equal(renamed.replaced, true);
  assert.equal(parsePeopleDoc(renamed.text).records.length, 1);
  assert.match(renamed.text, /辉夜（QQ 100000001）｜群主，周六开黑/);
  assert.equal(removePersonRow(renamed.text, '100000001').removed, true);
  assert.equal(personRow({ name: '某人' }), '- 某人｜置信：确认');
});

test('表情包记录：解析出名字 / 含义 / 路径（只供 search，不进热层提示词）', () => {
  const records = recordsFromStickers([
    { name: '委屈猫', meaning: '委屈、求安慰', scene: '对方凶我时', path: '.qq-stickers/委屈猫.gif', date: '2026-10-12', lineNo: 4, line: '- 委屈猫｜…' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'sticker');
  assert.match(records[0].text, /委屈猫 —— 委屈、求安慰/);
});

test('降级：统计文件损坏 / 缺失时按没有统计处理，不抛错、不空注入', () => {
  const records = recordsOf(MEMORY);
  const rendered = renderMemoryBlock({
    records,
    query: '海边团建',
    scope: 'group:1',
    // 索引坏了：传一个字符串、一个 null 键、一个数字
    stats: 'not-an-object',
    config: { promptChars: 6000 },
  });
  assert.ok(rendered.picked.length > 0);
  assert.match(rendered.text, /去了海边/);
});

test('归档：超过阈值才滚，只减不增，条目守恒，热层不含指针行', () => {
  const rows = [];
  for (let index = 0; index < 400; index += 1) {
    rows.push(`- 事实${index}｜${'这条事实有一点长，用来把文件撑到阈值以上'.repeat(2)}｜首见 2026-0${(index % 9) + 1}-1${index % 9}`);
  }
  const markdown = `# 记忆\n\n## 事实与事件\n${rows.join('\n')}\n`;
  const before = Buffer.byteLength(markdown, 'utf8');
  const result = archivePlan(markdown, { maxBytes: 32768, ratio: 0.75, month: '2026-10' });
  assert.equal(result.needed, true);
  assert.equal(result.rolled, true);
  assert.ok(result.afterBytes < result.beforeBytes, '滚档只能减');
  assert.ok(result.afterBytes <= result.targetBytes, '滚完要回到阈值以下');
  const archived = result.archive.reduce((sum, file) => sum + file.rows.length, 0);
  assert.equal(archived, result.removed.length, '条目守恒：删掉的条数 == 归档的条数');
  assert.equal(parseMemoryDoc(result.hot).records.length + archived, parseMemoryDoc(markdown).records.length);
  assert.equal(result.removed.length > 0, true);
  assert.doesNotMatch(result.hot, /见 archive|更早的|归档在/, '热层里不许写指针行');
});

test('归档：全是 pinned 时不硬删，返回原因让人去处理', () => {
  const rows = [];
  for (let index = 0; index < 100; index += 1) rows.push(`- 人物${index}（QQ 10000${String(index).padStart(4, '0')}）｜一个群友`);
  const markdown = `## 人\n${rows.join('\n')}\n`;
  const result = archivePlan(markdown, { maxBytes: 1024, ratio: 0.5 });
  assert.equal(result.needed, true);
  assert.equal(result.rolled, false);
  assert.match(result.reason, /pinned/);
  assert.equal(result.hot, markdown, '不滚的时候热层原样不动');
});

test('归档：没有超过阈值时什么都不做（热层原文返回）', () => {
  const markdown = '## 事实与事件\n- 一条事实｜一句话\n';
  const result = archivePlan(markdown, { maxBytes: 32768, ratio: 0.75 });
  assert.equal(result.needed, false);
  assert.equal(result.rolled, false);
  assert.equal(result.hot, markdown);
});

test('连续滚档 200 次：热层始终低于阈值、条目总数等于原始数、指针行恒为 0', () => {
  const maxBytes = 4000;
  const ratio = 0.5;
  let hot = '# 记忆\n\n## 事实与事件\n';
  let appended = 0;
  let archived = 0;
  const pad = '这一条事实比较长，用来把热层推到阈值以上，测试反复滚档也不会丢条目';
  for (let round = 0; round < 200; round += 1) {
    hot += `- 事实${round}｜${pad}｜首见 2026-10-01\n`;
    appended += 1;
    const plan = archivePlan(hot, { maxBytes, ratio, month: '2026-10' });
    if (plan.needed) {
      assert.equal(plan.rolled, true, `第 ${round} 轮应当能滚档`);
      hot = plan.hot;
      archived += plan.removed.length;
    }
    const bytes = Buffer.byteLength(hot, 'utf8');
    assert.ok(bytes <= maxBytes * ratio + 1, `第 ${round} 轮滚完仍然超阈值：${bytes}`);
    assert.doesNotMatch(hot, /见 archive|更早的|归档在/, '热层里不许累积指针行');
  }
  assert.equal(archived + parseMemoryDoc(hot).records.length, appended, '条目总数必须等于写入数');
});

test('人物去重：全局 PEOPLE.md 的条目赢过老 group MEMORY.md 里的同一个人', () => {
  const records = [
    fakeRecord(0, { scope: 'global', kind: 'person', section: '人', name: 'kaguya', qq: '100000001', text: 'kaguya（QQ 100000001）：全局人物表里的版本' }),
    fakeRecord(1, { scope: 'group:1', kind: 'person', section: '人', name: 'kaguya', qq: '100000001', text: 'kaguya（QQ 100000001）：群记忆里的旧副本' }),
  ];
  const rendered = block(records, '', { focus: ['kaguya'] });
  assert.match(rendered.text, /全局人物表里的版本/);
  assert.doesNotMatch(rendered.text, /群记忆里的旧副本/);
  assert.equal(rendered.picked.filter((record) => record.kind === 'person').length, 1);
});
