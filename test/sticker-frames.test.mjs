/**
 * 已收藏动图的分镜图索引：只扫 GIF、只收多帧、按内容哈希存、删掉没有对应表情的旧图。
 *
 * 为什么要单测这层：它是「表情包目录」与「媒体目录」之间唯一的胶水 —— 写错一个路径，
 * 模型拿到的就是一张读不到的图；写错命名，同一个表情改个名就多占一份磁盘。都用真文件测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStickerFrames } from '../sticker-frames.js';
import { buildGif } from './gif-fixtures.mjs';
import { PIC_PNG } from './image-fixtures.mjs';

/** 造一张纯色动图：`frames` 帧、每帧一个颜色、8×8。 */
function animatedGif(frames, color = 0) {
  return buildGif({
    width: 8,
    height: 8,
    palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]],
    frames: Array.from({ length: frames }, (_, index) => ({
      width: 8,
      height: 8,
      indices: Array(64).fill((color + index) % 4),
      delayMs: 100,
    })),
  });
}

/** 起一个临时 cwd，里面放好表情包目录。 */
async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-sticker-frames-'));
  await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
  return cwd;
}

function store(cwd, options = {}) {
  return createStickerFrames({
    cwd,
    stickerDir: '.qq-stickers',
    mediaDirectory: join(cwd, '.qq-media'),
    ...options,
  });
}

test('sticker-frames：只给动图做分镜图，静图和普通图片不进对照表', async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, '.qq-stickers', '转圈.gif'), animatedGif(3));
    await writeFile(join(cwd, '.qq-stickers', '不动.gif'), animatedGif(1));
    await writeFile(join(cwd, '.qq-stickers', '照片.png'), PIC_PNG);
    const frames = store(cwd);
    await frames.refresh();

    const lines = frames.lines();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /转圈\.gif（3 帧）→ \.qq-media\/sticker-frames\/[0-9a-f]{32}\.png/);
    assert.ok(!lines[0].includes('不动.gif'), lines[0]);
    assert.ok(!lines[0].includes('照片.png'), lines[0]);

    const match = /\.qq-media\/sticker-frames\/([0-9a-f]{32}\.png)/.exec(lines[0]);
    assert.ok(match, lines[0]);
    const sheet = await readFile(join(cwd, '.qq-media/sticker-frames', match[1]));
    assert.equal(sheet.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sticker-frames：再扫一次不会重复拆帧，改名后复用同一张分镜图', async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, '.qq-stickers', '转圈.gif'), animatedGif(2));
    const frames = store(cwd);
    await frames.refresh();
    const first = frames.signature();
    assert.match(first, /^转圈\.gif:/);

    await frames.refresh();
    assert.equal(frames.signature(), first, '同样的目录不该产生新的签名');

    // 改名只改文件名，内容哈希没变 → 分镜图文件还是那一张。
    await rename(join(cwd, '.qq-stickers', '转圈.gif'), join(cwd, '.qq-stickers', '加载.gif'));
    await frames.refresh();
    assert.match(frames.signature(), /^加载\.gif:/);
    const sheets = await readdir(join(cwd, '.qq-media/sticker-frames'));
    assert.equal(sheets.length, 1, '改名不该多出一张分镜图');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sticker-frames：表情被删掉之后，它的分镜图也一起清掉', async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, '.qq-stickers', '甲.gif'), animatedGif(2, 0));
    await writeFile(join(cwd, '.qq-stickers', '乙.gif'), animatedGif(2, 1));
    const frames = store(cwd);
    await frames.refresh();
    assert.equal((await readdir(join(cwd, '.qq-media/sticker-frames'))).length, 2);

    await unlink(join(cwd, '.qq-stickers', '甲.gif'));
    await frames.refresh();
    assert.equal((await readdir(join(cwd, '.qq-media/sticker-frames'))).length, 1);
    assert.ok(!frames.lines()[0].includes('甲.gif'), frames.lines()[0]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sticker-frames：坏掉的 GIF 只跳过它自己，别的表情照常出图', async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, '.qq-stickers', '好的.gif'), animatedGif(2));
    await writeFile(join(cwd, '.qq-stickers', '坏的.gif'), Buffer.from('GIF89a garbage', 'latin1'));
    const warnings = [];
    const frames = store(cwd, { report: (level, message) => warnings.push([level, message]) });
    await frames.refresh();
    assert.match(frames.lines()[0], /好的\.gif/);
    assert.ok(!frames.lines()[0].includes('坏的.gif'));
    assert.ok(warnings.some(([level]) => level === 'warn'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sticker-frames：媒体下载关掉、或没配表情包目录时什么都不做', async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, '.qq-stickers', '转圈.gif'), animatedGif(2));
    const off = store(cwd, { enabled: false });
    await off.refresh();
    assert.deepEqual(off.lines(), []);
    assert.deepEqual(await readdir(join(cwd, '.qq-media')).catch(() => []), []);

    const none = createStickerFrames({ cwd, stickerDir: '', mediaDirectory: join(cwd, '.qq-media'), enabled: true });
    await none.refresh();
    assert.deepEqual(none.lines(), []);
    assert.equal(none.signature(), '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
