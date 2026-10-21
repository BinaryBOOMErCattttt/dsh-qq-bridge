/**
 * `memory.js` 的接线测试 —— 只钉「磁盘上的东西真的被读进来了」这一层。
 *
 * 为什么单开一个文件：`memory-select.js` 的纯函数（含 `archiveLineOf`）已经被
 * `memory-select.test.mjs` 钉死了，它们从来没错。错的是**喂给它们的月份从哪来** ——
 * `archiveMonthsOf` 漏了 `readdirSync` 的 import，ReferenceError 又被裸 `catch {}` 当成
 * 「目录还没建」，于是聚合行恒不出现。一个纯函数测试永远抓不到这种洞，这里必须真的给一个目录。
 *
 * 用到的依赖全部是桩：只需要 `settings` / `cwd` / `report`，其余（Agent 装配、会话表）在这个
 * 路径上不会被碰。`conversations` 给空 Map 就行 —— `recallText` 只按 key 读盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory } from '../memory.js';
import { memorySlug } from '../util.js';

/** 会话 key → 目录名（`memorySlug`）：`group:1` 落在 `conversations/group-1/`。 */
const KEY = 'group:1';

/** 一个够用的 settings 桩：只有记忆注入这条路径会读到的字段。 */
const SETTINGS = {
  memory: true,
  memoryDir: '.qq-memory',
  memoryFileMaxBytes: 32768,
  memoryPromptChars: 4000,
  memoryRecallK: 8,
  memoryPeopleMax: 12,
  memoryVocabHint: true,
};

/**
 * 造一个临时 cwd（自动清理）+ 一个把 `report` 调用记下来的收集器。
 * @param {import('node:test').TestContext} t - 当前用例。
 */
async function scratch(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-memory-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const reported = [];
  const conversations = new Map();
  const sessionIndex = new Map();
  const memory = createMemory({
    ctx: {},
    settings: SETTINGS,
    cwd,
    report: (level, message) => reported.push({ level, message }),
    conversations,
    sessionIndex,
    ambientQuery: () => ({}),
    allowTools: [],
    approvalPolicy: 'never',
    resolveRoute: () => undefined,
    resolveAgentPreset: () => undefined,
    mountAgentPreset: () => undefined,
    restrictAgentTools: () => undefined,
    channelSectionOrder: 8950,
  });
  return { cwd, memory, reported, conversations, sessionIndex };
}

/** 给一个会话造出「有转录、有 MEMORY.md、有 meta.json」的目录。 */
async function seedConversation(cwd, key, { text = '一条记录' } = {}) {
  const dir = join(cwd, '.qq-memory', 'conversations', memorySlug(key));
  await mkdir(join(dir, 'log'), { recursive: true });
  await writeFile(join(dir, 'MEMORY.md'), `# 记忆\n\n- 测试｜${text}\n`);
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ key, name: key }));
  await writeFile(
    join(dir, 'log', '2026-10-21.jsonl'),
    `${JSON.stringify({ at: Date.now(), name: '某人', text, kind: 'message' })}\n`,
  );
}

/** 写一个归档文件（`YYYY-MM.md`）。 */
async function archiveFile(cwd, name, body = '- 旧事｜很久以前\n') {
  const dir = join(cwd, '.qq-memory', 'conversations', 'group-1', 'archive');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), body);
}

test('archive/ 里有月份时，注入块必须带上「更早的记忆」聚合行', async (t) => {
  const { cwd, memory, reported } = await scratch(t);
  await archiveFile(cwd, '2026-10.md');
  await archiveFile(cwd, '2026-09.md');

  const text = memory.recallText({ key: KEY });

  // 回归的那一行：`archiveMonthsOf` 读不到目录时这里是空的，整段提示词也跟着空。
  assert.match(text, /更早的记忆：archive\/ 下 2 个文件（2026-09 … 2026-10），用 qq_memory search 查。/);
  assert.deepEqual(reported.filter((item) => item.level !== 'info'), []);
});

test('非 YYYY-MM.md 的文件不算归档月份', async (t) => {
  const { cwd, memory } = await scratch(t);
  await archiveFile(cwd, '2026-10.md');
  await archiveFile(cwd, 'notes.txt', '不是归档\n');
  await archiveFile(cwd, '2026-1.md', '月份没补零，按约定不认\n');

  const text = memory.recallText({ key: KEY });
  assert.match(text, /更早的记忆：archive\/ 下 1 个文件（2026-10 … 2026-10）/);
});

test('没有归档也没有任何记忆时，宁可返回空串也不给一个空标题', async (t) => {
  const { cwd, memory } = await scratch(t);
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });

  assert.equal(memory.recallText({ key: KEY }), '');
});

/**
 * 「只给一次」契约：记忆块每轮都跟着 user message 投递、一直留在历史里，
 * 人物表 + 索引 + 词汇表每轮重发一遍，三十几轮就把上下文顶到压缩门槛 ——
 * 压缩会把它改写成一英文技术备忘录，群里看到的就是「越聊越人机」。
 *
 * 所以同一个会话轮次里，同一条记录 / 索引 / 归档聚合行只出现一次；换代再给。
 */
test('同一条记忆、同一份索引与归档行，在一个会话轮次里只给一次', async (t) => {
  const { cwd, memory } = await scratch(t);
  await seedConversation(cwd, KEY, { text: '周六打本' });
  await archiveFile(cwd, '2026-10.md');
  await writeFile(join(cwd, '.qq-memory', 'INDEX.md'), '- 群 1：周六常组织打本', 'utf8');

  const first = memory.recallText({ key: KEY, sessionGeneration: 0 });
  assert.match(first, /测试：周六打本/);
  assert.match(first, /### 全局索引（INDEX.md）/);
  assert.match(first, /更早的记忆：archive\/ 下 1 个文件/);
  // 第二条消息：这一轮没有新东西，一个字都不给（不是再发一份同样的）。
  assert.equal(memory.recallText({ key: KEY, sessionGeneration: 0 }), '');
  // 换代（/reset、静默换轮）：账本重开，人物 / 索引 / 归档行再给一遍。
  const next = memory.recallText({ key: KEY, sessionGeneration: 1 });
  assert.match(next, /测试：周六打本/);
  assert.match(next, /### 全局索引（INDEX.md）/);
});

test('学了新梗才重发词汇表：写法集合没变就不占篇幅', async (t) => {
  const { cwd, memory } = await scratch(t);
  const dir = join(cwd, '.qq-memory');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'COGNITION.md'), '## 黑话与缩写\n- 老说法｜很久以前学的，从来没写日期\n', 'utf8');

  assert.match(memory.recallText({ key: KEY, sessionGeneration: 0 }), /词汇表（全部梗的写法/);
  assert.equal(memory.recallText({ key: KEY, sessionGeneration: 0 }), '', '同一批写法不重复给');

  // 摘要 / 学梗写进新条目之后，下一次装配要把新的写法带上（否则新梗等于白学）。
  await writeFile(join(dir, 'COGNITION.md'), '## 黑话与缩写\n- 老说法｜很久以前学的，从来没写日期\n- 新说法｜今天刚学的\n', 'utf8');
  const after = memory.recallText({ key: KEY, sessionGeneration: 0 });
  assert.match(after, /词汇表（全部梗的写法/);
  assert.match(after, /新说法/);
});

/**
 * 第一轮给一份「底色」（人物表 + pinned / 最近的几条），之后只让**真正命中**当前消息的
 * 记录进来。只做「去掉给过的」不够：`renderMemoryBlock` 的兜底每轮都会按 salience / 最近
 * 捞出几条没问到的记忆，六轮实测仍会多出 9k 字（`fallback: false` 就是挡这个的）。
 */
test('第一轮给过底色之后，只有命中当前消息的记录才进来', async (t) => {
  const { cwd, memory } = await scratch(t);
  await seedConversation(cwd, KEY, { text: '周六打本' });
  const ask = (text) => ({ key: KEY, sessionGeneration: 0, recallQuery: { text, speakers: [] } });

  assert.match(memory.recallText(ask('在吗')), /测试：周六打本/);

  // 摘要新写进来一条：还没给过，但和这条消息无关 → 不进来（兜底已经用过了）。
  await writeFile(
    join(cwd, '.qq-memory', 'conversations', memorySlug(KEY), 'MEMORY.md'),
    '# 记忆\n\n- 测试｜周六打本\n- 打本｜周六下午两点集合\n',
    'utf8',
  );
  assert.equal(memory.recallText(ask('今天吃什么')), '');

  // 真的问到了才给，而且只给这一条。
  const hit = memory.recallText(ask('打本几点集合'));
  assert.match(hit, /打本：周六下午两点集合/);
  assert.doesNotMatch(hit, /测试：周六打本/);
});

/**
 * 三条越权回归：`qq_transcript` / `qq_memory` 是 QQ 会话能直接调用的工具，
 * 而 scope 过滤只作用于提示词注入。没有这一层，群里让模型读一次
 * `private:<号>` 就能把私聊记录原样拿回群里（docs/memory.md 的「永不升级」形同虚设）。
 */
function registerConversation({ conversations, sessionIndex }, key, agentId) {
  const [type, id] = key.split(':');
  conversations.set(key, { key, type, id, name: key });
  sessionIndex.set(agentId, key);
}

test('qq_transcript：群会话列不到、也读不到私聊与别的群', async (t) => {
  const maps = await scratch(t);
  const { cwd, memory } = maps;
  registerConversation(maps, 'group:1', 'agent-group');
  registerConversation(maps, 'private:2', 'agent-private');
  await seedConversation(cwd, 'group:1', { text: '群里的记录' });
  await seedConversation(cwd, 'private:2', { text: '私聊的秘密' });
  const groupExec = { agent: { id: 'agent-group' } };

  const listed = await memory.tools.listTranscripts(groupExec);
  assert.deepEqual(listed.lines.map((line) => line.conversation), ['group:1']);
  assert.equal(listed.lines[0].last_text, '群里的记录');

  // 显式传 key、传裸号都拒绝；不传时仍然落到自己。
  assert.throws(
    () => memory.tools.resolveConversation({ conversation: 'private:2' }, groupExec, 'qq_transcript'),
    /only access its own records/,
  );
  assert.throws(
    () => memory.tools.resolveConversation({ conversation: '2' }, groupExec, 'qq_transcript'),
    /only access its own records/,
  );
  assert.equal(memory.tools.resolveConversation({}, groupExec, 'qq_transcript').key, 'group:1');

  // private 侧对称：也不能反过来读群。
  const privateExec = { agent: { id: 'agent-private' } };
  assert.throws(
    () => memory.tools.resolveConversation({ conversation: 'group:1' }, privateExec, 'qq_transcript'),
    /only access its own records/,
  );
});

test('qq_memory：显式 path 也不能指向别的会话', async (t) => {
  const maps = await scratch(t);
  const { cwd, memory } = maps;
  registerConversation(maps, 'group:1', 'agent-group');
  registerConversation(maps, 'private:2', 'agent-private');
  await seedConversation(cwd, 'group:1');
  await seedConversation(cwd, 'private:2');
  const groupExec = { agent: { id: 'agent-group' } };
  const resolve = (args) => memory.tools.resolvePath(args, 'qq_memory', groupExec);

  assert.throws(() => resolve({ path: 'conversations/private-2/MEMORY.md' }), /own memory/);
  assert.throws(() => resolve({ conversation: 'private:2' }), /only access its own records/);
  assert.equal(resolve({ path: 'conversations/group-1/MEMORY.md' }), 'conversations/group-1/MEMORY.md');
  assert.equal(resolve({ path: 'COGNITION.md' }), 'COGNITION.md');

  // list 只列全局文件 + 自己的目录。
  const files = (await memory.tools.listFiles(groupExec)).files;
  assert.ok(files.some((file) => file.endsWith('conversations/group-1/MEMORY.md')));
  assert.ok(files.every((file) => !file.includes('private-2')));
  assert.ok(files.every((file) => !file.endsWith('memory.index.json')));
});

test('摘要会话与宿主平面仍然可以跨会话读（它们是受信调用者）', async (t) => {
  const maps = await scratch(t);
  const { cwd, memory } = maps;
  registerConversation(maps, 'group:1', 'agent-group');
  registerConversation(maps, 'private:2', 'agent-private');
  await seedConversation(cwd, 'group:1');
  await seedConversation(cwd, 'private:2');

  // 摘要 Agent 不在 sessionIndex 里 —— 它的调用不受「只能碰自己」限制。
  const digestExec = { agent: { id: 'agent-digest' } };
  assert.equal(
    memory.tools.resolveConversation({ conversation: 'private:2' }, digestExec, 'qq_transcript').key,
    'private:2',
  );
  assert.equal(
    memory.tools.resolvePath({ path: 'conversations/private-2/MEMORY.md' }, 'qq_memory', digestExec),
    'conversations/private-2/MEMORY.md',
  );
  assert.equal((await memory.tools.listTranscripts(digestExec)).lines.length, 2);

  // 宿主平面（没有 exec.agent）同样不受限。
  assert.equal(memory.tools.resolveConversation({ conversation: 'private:2' }, {}, 'qq_transcript').key, 'private:2');
});
