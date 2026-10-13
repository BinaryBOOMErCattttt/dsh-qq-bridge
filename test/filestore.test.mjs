/**
 * `filestore.js` 的契约测试。
 *
 * 这几个函数的**失败语义**就是它们的全部价值：读不到要给空/undefined 而不是抛错，
 * 否则调用方（记忆、转录、摘要状态）每处都得包一层 try。这种「不抛错」的约定一旦
 * 被谁顺手改成抛错，症状是插件在真宿主上到处炸，而不是某个测试红 —— 所以在这里钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonl, readTextOrUndefined, readdirOrEmpty, writeJsonAtomic, writeTextAtomic } from '../filestore.js';

/** 建一个临时目录，跑完删掉。 */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-filestore-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writeTextAtomic 落盘，且不留临时文件', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'a.md');
    await writeTextAtomic(file, '# 记忆\n第一行\n');
    assert.equal(await readFile(file, 'utf8'), '# 记忆\n第一行\n');
    // 两个写入点（writeFile + rename）之间会留一个 `.tmp`；成功之后必须没有。
    await assert.rejects(() => stat(`${file}.tmp`), /ENOENT/);
  });
});

test('writeTextAtomic 覆盖已有文件（不是追加）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'a.md');
    await writeTextAtomic(file, '旧的');
    await writeTextAtomic(file, '新的');
    assert.equal(await readFile(file, 'utf8'), '新的');
  });
});

test('writeJsonAtomic 写的是带缩进、带结尾换行的 JSON', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'digest.json');
    await writeJsonAtomic(file, { conversations: { 'group:1': { lastDigestAt: 5 } } });
    // 缩进 + 结尾换行都是刻意的：这些文件是给人看、也会被手工改的。
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify({ conversations: { 'group:1': { lastDigestAt: 5 } } }, null, 2)}\n`);
  });
});

test('readTextOrUndefined：读不到就是 undefined，不抛错', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readTextOrUndefined(join(dir, '没有这个文件')), undefined);
    // ENOTDIR：路径中间有一段是文件 —— 同样是「读不到」，不该炸。
    await writeFile(join(dir, 'a-file'), 'x', 'utf8');
    assert.equal(await readTextOrUndefined(join(dir, 'a-file', 'b.txt')), undefined);
  });
});

test('readJsonl：坏行跳过，好行照收', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'log.jsonl');
    // 转录是「尽力而为」的历史，不是账本：写到一半被杀留下的半截行不能毁掉整段历史。
    await writeFile(file, [
      '{"at":1,"text":"第一条"}',
      '',
      '   ',
      '{坏掉的 json',
      '"只是个字符串"',
      '123',
      'null',
      '{"at":2,"text":"第二条"}',
    ].join('\n'), 'utf8');
    assert.deepEqual(await readJsonl(file), [{ at: 1, text: '第一条' }, { at: 2, text: '第二条' }]);
  });
});

test('readJsonl：文件不存在时是空数组', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readJsonl(join(dir, '没有这个.jsonl')), []);
  });
});

test('readdirOrEmpty：目录不存在或其实是文件时都是空数组', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readdirOrEmpty(join(dir, '没有这个目录')), []);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'a.txt'), 'x', 'utf8');
    assert.deepEqual(await readdirOrEmpty(join(dir, 'sub')), ['a.txt']);
    await writeFile(join(dir, 'a-file'), 'x', 'utf8');
    assert.deepEqual(await readdirOrEmpty(join(dir, 'a-file')), [], 'ENOTDIR 也当成「空」');
  });
});
