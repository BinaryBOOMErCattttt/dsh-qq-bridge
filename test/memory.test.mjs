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
  const memory = createMemory({
    ctx: {},
    settings: SETTINGS,
    cwd,
    report: (level, message) => reported.push({ level, message }),
    conversations: new Map(),
    sessionIndex: new Map(),
    ambientQuery: () => ({}),
    allowTools: [],
    approvalPolicy: 'never',
    resolveRoute: () => undefined,
    resolveAgentPreset: () => undefined,
    mountAgentPreset: () => undefined,
    restrictAgentTools: () => undefined,
    channelSectionOrder: 8950,
  });
  return { cwd, memory, reported };
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
