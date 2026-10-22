/**
 * `scripts/forget.mjs` 的判据测试：真的忘掉一个会话时，删的必须正好是那一个会话的东西。
 *
 * 这一层最容易犯的错是「删多了」：多删一个别的群、多删一张别处还在用的图、或者把
 * `memory.index.json` 里别人的统计一起清掉。所以测试不只验「目标没了」，还要验
 * 「别的还在」，以及 `--with-digest` / `--with-media` 这两个共享资源的开关。
 *
 * 全部在临时目录里跑，不碰真的 `.qq-memory` 与 `~/.dsh`。
 *
 * 运行：node --test test/forget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applyForget, forgetTargets, parseForgetKey, planForget, sessionProjectKey } from '../scripts/forget.mjs';
import { OPS_COMMANDS } from '../ops.js';
import { memorySlug, sessionIdFor } from '../util.js';

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** 一套最小但完整的「这个会话有记忆」现场：转录 / 记忆 / 索引 / 统计 / 会话档 / reset 标记。 */
function fixture(key = 'private:2904544617') {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-forget-'));
  const slug = memorySlug(key);
  const memory = join(root, '.qq-memory');
  const conversation = join(memory, 'conversations', slug);
  write(join(conversation, 'log', '2026-10-20.jsonl'), '{"text":"hi"}\n');
  write(join(conversation, 'MEMORY.md'), '- 一张图 .qq-media/abc123.jpg\n');
  write(join(conversation, 'archive', '2026-09.md'), '- 旧条目\n');
  write(join(conversation, 'meta.json'), '{}\n');
  write(join(memory, 'conversations', 'group-999', 'MEMORY.md'), '- 别的会话\n');
  write(
    join(memory, 'INDEX.md'),
    `# 记忆索引\n- 私聊：conversations/${slug}/MEMORY.md\n- 群：conversations/group-999/MEMORY.md\n`,
  );
  write(
    join(memory, 'memory.index.json'),
    `${JSON.stringify({
      version: 1,
      builtAt: 1,
      stats: {
        [`fact:${key}:事实与事件:一张图`]: { hits: 1, lastSeen: 1 },
        'fact:group:999:事实与事件:别的': { hits: 1, lastSeen: 1 },
      },
    }, null, 2)}\n`,
  );
  const media = join(root, '.qq-media', 'abc123.jpg');
  write(media, 'img');
  const historyName = `conversations_${slug}_MEMORY.md.2026-10-19T00-00-00-000Z.md`;
  const historyFile = join(memory, '.history', historyName);
  write(historyFile, '- 旧版本：.qq-media/abc123.jpg\n');

  const sessionsRoot = join(root, 'sessions');
  const project = join(sessionsRoot, sessionProjectKey(root));
  for (const generation of [0, 1]) {
    write(join(project, sessionIdFor(key, generation), 'session.v4.jsonl.zstd'), 'dummy');
  }
  write(join(project, sessionIdFor('bridge:digest'), 'session.v4.jsonl.zstd'), 'dummy-digest');
  const resetFile = join(sessionsRoot, 'reset', `${slug}.json`);
  write(resetFile, `${JSON.stringify({ key, count: 1 }, null, 2)}\n`);

  return { root, key, slug, memory, conversation, sessionsRoot, project, media, resetFile, historyName, historyFile };
}

function options(f, extra = {}) {
  return { key: f.key, cwd: f.root, sessionsRoot: f.sessionsRoot, ...extra };
}

test('forget：只认 group:/private: + 数字', () => {
  assert.deepEqual(parseForgetKey(' private:2904544617 '), {
    key: 'private:2904544617',
    type: 'private',
    id: '2904544617',
  });
  assert.equal(parseForgetKey('group:709563326').type, 'group');
  for (const bad of ['private:', 'private:abc', 'private:12', 'group:709563326x', 'group', '']) {
    assert.equal(parseForgetKey(bad), undefined, `应当拒绝「${bad}」`);
  }
});

test('forget：会话项目目录名与 DSH 的 projectKey 一致', () => {
  assert.equal(sessionProjectKey('/home/shelter/Projects/qqbot'), '--home-shelter-Projects-qqbot--');
  assert.equal(sessionProjectKey('C:\\Users\\u\\qqbot'), '--C-Users-u-qqbot--');
  assert.equal(sessionProjectKey('/tmp/a b'), '--tmp-a~0020b--');
});

test('forget：memoryDir 跑到 cwd 外就拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-forget-'));
  assert.throws(
    () => forgetTargets({ key: 'private:123', cwd: root, memoryDir: '../outside', sessionsRoot: join(root, 's') }),
    /cwd 之外/,
  );
});

test('forget：计划是只读的，但能算清每一项', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const plan = await planForget(options(f, { withMedia: true }));
  assert.equal(plan.conversation.exists, true);
  assert.equal(plan.conversation.files, 4);
  assert.equal(plan.index.removed, 1);
  assert.equal(plan.stats.removed, 1);
  assert.deepEqual(plan.history.map((item) => item.name), [f.historyName]);
  assert.equal(plan.round.count, 1);
  assert.deepEqual(plan.generations.map((item) => item.generation), [0, 1]);
  assert.equal(plan.nextRound, 2);
  assert.equal(plan.media.length, 1);
  assert.equal(plan.media[0].exists, true);
  assert.equal(plan.media[0].referencedElsewhere, false);

  // 计划不该动磁盘上任何东西。
  assert.ok(existsSync(f.conversation));
  assert.ok(existsSync(f.media));
  assert.ok(existsSync(f.resetFile));
});

test('forget：--apply 先备份再删，别的会话不受影响', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const plan = await planForget(options(f, { withMedia: true }));
  const result = await applyForget(plan, { backupRoot: join(f.root, 'backups'), withMedia: true });

  assert.equal(result.removedConversation, true);
  assert.equal(result.prunedIndex, 1);
  assert.equal(result.prunedStats, 1);
  assert.deepEqual(result.removedHistory, [f.historyName]);
  assert.equal(result.removedSessions.length, 2);
  assert.equal(result.wroteRound, true);
  assert.equal(result.nextRound, 2);

  assert.equal(existsSync(f.conversation), false);
  assert.equal(existsSync(f.historyFile), false);
  assert.equal(existsSync(f.media), false);
  assert.equal(JSON.parse(readFileSync(f.resetFile, 'utf8')).count, 2);

  // 别的会话、别的统计都还在。
  assert.ok(existsSync(join(f.memory, 'conversations', 'group-999', 'MEMORY.md')));
  const index = readFileSync(join(f.memory, 'INDEX.md'), 'utf8');
  assert.ok(!index.includes(f.slug), '索引里还留着这个会话');
  assert.ok(index.includes('group-999'), '别的会话被顺手删了');
  const stats = JSON.parse(readFileSync(join(f.memory, 'memory.index.json'), 'utf8'));
  assert.deepEqual(Object.keys(stats.stats), ['fact:group:999:事实与事件:别的']);

  // 备份里有恢复需要的东西。
  assert.ok(existsSync(join(result.backupDir, 'README.txt')));
  assert.ok(existsSync(join(result.backupDir, 'memory', 'MEMORY.md')));
  assert.ok(existsSync(join(result.backupDir, 'index', 'INDEX.md')));
  assert.ok(existsSync(join(result.backupDir, 'history', f.historyName)));
  assert.ok(existsSync(join(result.backupDir, 'sessions', sessionIdFor(f.key, 0))));
  assert.ok(existsSync(join(result.backupDir, 'sessions', sessionIdFor(f.key, 1))));
  assert.ok(existsSync(join(result.backupDir, 'reset.json')));

  // 摘要会话是所有会话共用的：默认不删。
  assert.ok(existsSync(join(f.project, sessionIdFor('bridge:digest'))));

  // 再计划一次：已经没什么可删了（代次已经到 2，也不会再找旧 id）。
  const again = await planForget(options(f));
  assert.equal(again.conversation.exists, false);
  assert.equal(again.generations.length, 0);
  assert.equal(again.index.removed, 0);
  assert.equal(again.stats.removed, 0);
});

test('forget：--with-digest 才删摘要会话', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const plan = await planForget(options(f));
  const result = await applyForget(plan, { backupRoot: join(f.root, 'backups'), withDigest: true });

  assert.equal(result.removedDigest, true);
  assert.equal(existsSync(join(f.project, sessionIdFor('bridge:digest'))), false);
  // 删之前也备了份：摘要会话里有别的会话的摘要历史，要能恢复。
  assert.ok(existsSync(join(result.backupDir, 'sessions', sessionIdFor('bridge:digest'))));
});

test('forget：别处还引用的图不删', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(join(f.memory, 'conversations', 'group-999', 'MEMORY.md'), '- 也用了 .qq-media/abc123.jpg\n');

  const plan = await planForget(options(f, { withMedia: true }));
  assert.equal(plan.media[0].referencedElsewhere, true);

  const result = await applyForget(plan, { backupRoot: join(f.root, 'backups'), withMedia: true });
  assert.equal(result.removedMedia.length, 0);
  assert.ok(existsSync(f.media), '别的会话还在引用的图被删了');
});

test('forget：memory.index.json 坏了就不覆盖它', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const statsFile = join(f.memory, 'memory.index.json');
  writeFileSync(statsFile, '{broken');

  const plan = await planForget(options(f));
  assert.ok(plan.stats.error, '坏 JSON 应当被记下来');
  assert.equal(plan.stats.removed, 0);

  await applyForget(plan, { backupRoot: join(f.root, 'backups') });
  assert.equal(readFileSync(statsFile, 'utf8'), '{broken');
});

test('forget：命令已经在 ops 的命令表里', () => {
  assert.ok(OPS_COMMANDS.includes('forget'));
});
