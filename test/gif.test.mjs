/**
 * GIF 拆帧的契约：整幅画面、处置方式、透明、隔行、局部色表、延时，以及抽帧与上限。
 *
 * 这些断言都逐像素对：分镜图是给模型「看过程」用的，少一帧或叠一层残影都会让它把
 * 表情包的意思读错，而这种错误在端到端测试里根本看不出来（尺寸、字节数都对得上）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeGif, decodeGifFrames, inspectGif, planFrameSample } from '../gif.js';
import { buildGif } from './gif-fixtures.mjs';
import { PIC_GIF, PIC_GIF_ANIM } from './image-fixtures.mjs';

/** 4 色调色板：红、绿、蓝、白。 */
const PALETTE = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];

/** 取一帧上某个像素的 RGB。 */
function pixel(frame, x, y) {
  const at = (y * frame.width + x) * 3;
  return Array.from(frame.rgb.subarray(at, at + 3));
}

test('GIF 拆帧：多帧动图按时间顺序给出整幅画面', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0) },
      { width: 4, height: 4, indices: Array(16).fill(1) },
      { width: 4, height: 4, indices: Array(16).fill(2) },
    ],
  });
  const info = inspectGif(gif);
  assert.equal(info.width, 4);
  assert.equal(info.height, 4);
  assert.equal(info.frameCount, 3);
  const frames = decodeGifFrames(info, [0, 1, 2]);
  assert.deepEqual(frames.map((frame) => frame.index), [0, 1, 2]);
  assert.deepEqual(pixel(frames[0], 0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(frames[1], 0, 0), [0, 255, 0]);
  assert.deepEqual(pixel(frames[2], 0, 0), [0, 0, 255]);
});

test('GIF 拆帧：帧矩形越过屏幕时按画布裁剪，不擦坏相邻行', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0), disposal: 1 },
      // 帧从 x=3 开始、宽 4：右半边在屏幕外。处置方式 2 只能擦屏幕内的那一列。
      { left: 3, top: 0, width: 4, height: 2, indices: Array(8).fill(1), disposal: 2 },
      // 最后一帧只改左下角，好让「上一帧被擦成什么样」露出来。
      { left: 0, top: 3, width: 1, height: 1, indices: [2] },
    ],
  });
  const [last] = decodeGifFrames(inspectGif(gif), [2]);
  assert.deepEqual(pixel(last, 3, 0), [255, 255, 255], '屏幕内那列被擦成透明（白底）');
  assert.deepEqual(pixel(last, 3, 1), [255, 255, 255]);
  assert.deepEqual(pixel(last, 0, 2), [255, 0, 0], '越界的擦除不能蔓延到别的行');
  assert.deepEqual(pixel(last, 0, 3), [0, 0, 255]);
});

test('GIF 拆帧：只解被点名的帧，但前面的帧仍参与合成', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0) },
      { left: 1, top: 1, width: 2, height: 2, indices: [1, 1, 1, 1] },
      { left: 2, top: 2, width: 2, height: 2, indices: [2, 2, 2, 2] },
    ],
  });
  const info = inspectGif(gif);
  const [third] = decodeGifFrames(info, [2]);
  assert.equal(third.index, 2);
  // 第二帧叠在红底上，第三帧再叠在「红底 + 绿块」上。
  assert.deepEqual(pixel(third, 1, 1), [0, 255, 0]);
  assert.deepEqual(pixel(third, 2, 2), [0, 0, 255]);
  assert.deepEqual(pixel(third, 0, 0), [255, 0, 0]);
});

test('GIF 拆帧：整帧不透明的画面各解各的（不必重放前面的帧）', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0) },
      { width: 4, height: 4, indices: Array(16).fill(1) },
      { width: 4, height: 4, indices: Array(16).fill(2) },
    ],
  });
  // 只点名最后一帧：它铺满屏幕且没有透明索引，结果与重放全部帧一致。
  const [third] = decodeGifFrames(inspectGif(gif), [2]);
  assert.deepEqual(pixel(third, 0, 0), [0, 0, 255]);
  assert.deepEqual(pixel(third, 3, 3), [0, 0, 255]);
});

test('GIF 拆帧：处置方式 2 在下一帧之前把矩形擦回背景', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0), disposal: 1 },
      { left: 1, top: 1, width: 2, height: 2, indices: [1, 1, 1, 1], disposal: 2 },
      { left: 2, top: 2, width: 2, height: 2, indices: [2, 2, 2, 2] },
    ],
  });
  const frames = decodeGifFrames(inspectGif(gif), [1, 2]);
  // 第二帧自己还在：绿块盖住红底。
  assert.deepEqual(pixel(frames[0], 1, 1), [0, 255, 0]);
  // 第三帧开始前，绿块被擦成透明（压白底），蓝块之外只剩帧零留下的红。
  assert.deepEqual(pixel(frames[1], 1, 1), [255, 255, 255]);
  assert.deepEqual(pixel(frames[1], 2, 2), [0, 0, 255]);
  assert.deepEqual(pixel(frames[1], 0, 0), [255, 0, 0]);
});

test('GIF 拆帧：处置方式 3 还原成画这一帧之前的样子', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0), disposal: 1 },
      { left: 1, top: 1, width: 2, height: 2, indices: [1, 1, 1, 1], disposal: 3 },
      { left: 2, top: 2, width: 2, height: 2, indices: [2, 2, 2, 2] },
    ],
  });
  const frames = decodeGifFrames(inspectGif(gif), [1, 2]);
  assert.deepEqual(pixel(frames[0], 1, 1), [0, 255, 0]);
  // 处置方式 3 = 回到「绿块还没画上去」的红底，而不是擦成透明。
  assert.deepEqual(pixel(frames[1], 1, 1), [255, 0, 0]);
  assert.deepEqual(pixel(frames[1], 2, 2), [0, 0, 255]);
});

test('GIF 拆帧：透明索引不覆盖画布（露出的是白底/上一帧）', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0), disposal: 1 },
      { left: 0, top: 0, width: 2, height: 2, indices: [2, 3, 3, 2], transparent: 3, disposal: 1 },
    ],
  });
  const frames = decodeGifFrames(inspectGif(gif), [1]);
  assert.deepEqual(pixel(frames[0], 0, 0), [0, 0, 255]);
  // 索引 3 是透明色：底下的红要透出来，不该被刷成白色。
  assert.deepEqual(pixel(frames[0], 1, 0), [255, 0, 0]);
});

test('GIF 拆帧：隔行帧的 8/8/4/2 行序能还原成逐行画面', () => {
  // 第 y 行整行用索引 y % 4，行序错了会立刻看出来。
  const indices = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) indices.push(y % 4);
  const gif = buildGif({
    width: 4,
    height: 8,
    palette: PALETTE,
    frames: [{ width: 4, height: 8, indices, interlaced: true }],
  });
  const [frame] = decodeGifFrames(inspectGif(gif), [0]);
  for (let y = 0; y < 8; y++) assert.deepEqual(pixel(frame, 0, y), PALETTE[y % 4], `第 ${y} 行`);
});

test('GIF 拆帧：局部调色板优先于全局调色板', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE,
    frames: [
      { width: 2, height: 2, indices: [0, 0, 0, 0] },
      {
        width: 2,
        height: 2,
        indices: [0, 1, 1, 0],
        palette: [[0, 0, 0], [250, 120, 30]],
      },
    ],
  });
  const frames = decodeGifFrames(inspectGif(gif), [1]);
  assert.deepEqual(pixel(frames[0], 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(frames[0], 1, 0), [250, 120, 30]);
});

test('GIF 拆帧：延时按 1/100 秒折算，0 延时按 100ms 兜底', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE,
    frames: [
      { width: 2, height: 2, indices: [0, 0, 0, 0], delayMs: 50 },
      { width: 2, height: 2, indices: [1, 1, 1, 1], delayMs: 0 },
      { width: 2, height: 2, indices: [2, 2, 2, 2], delayMs: 1200 },
    ],
  });
  const info = inspectGif(gif);
  assert.deepEqual(info.frames.map((frame) => frame.delayMs), [50, 0, 1200]);
  assert.equal(info.durationMs, 50 + 100 + 1200);
});

test('GIF 抽帧：整段均匀取样，首帧与末帧一定在内', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE,
    frames: Array.from({ length: 10 }, () => ({ width: 2, height: 2, indices: [0, 0, 0, 0] })),
  });
  const plan = planFrameSample(inspectGif(gif), { maxFrames: 4 });
  assert.deepEqual(plan.indices, [0, 3, 6, 9]);
  assert.equal(plan.truncated, false);
});

test('GIF 抽帧：像素预算不够时只取前一段并标 truncated', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: Array.from({ length: 10 }, () => ({ width: 4, height: 4, indices: Array(16).fill(0) })),
  });
  // 每帧 16 像素，预算 48 → 只够 3 帧。
  const plan = planFrameSample(inspectGif(gif), { maxFrames: 6, maxDecodedPixels: 48 });
  assert.equal(plan.window, 3);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.indices, [0, 1, 2]);
});

test('GIF 抽帧：帧数少于上限时全都取，静图只取第一帧', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE,
    frames: [
      { width: 2, height: 2, indices: [0, 0, 0, 0] },
      { width: 2, height: 2, indices: [1, 1, 1, 1] },
    ],
  });
  assert.deepEqual(planFrameSample(inspectGif(gif), { maxFrames: 6 }).indices, [0, 1]);
  const single = buildGif({ width: 2, height: 2, palette: PALETTE, frames: [{ width: 2, height: 2, indices: [0, 0, 0, 0] }] });
  assert.deepEqual(planFrameSample(inspectGif(single), { maxFrames: 6 }).indices, [0]);
});

test('GIF 解码：一步到位给出帧数、总时长与被抽中的帧', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: Array(16).fill(0), delayMs: 100 },
      { width: 4, height: 4, indices: Array(16).fill(1), delayMs: 100 },
    ],
  });
  const decoded = decodeGif(gif, { maxFrames: 6 });
  assert.equal(decoded.frameCount, 2);
  assert.equal(decoded.durationMs, 200);
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.truncated, false);
  assert.deepEqual(pixel(decoded.frames[1], 0, 0), [0, 255, 0]);
});

test('GIF 解码：真实的两帧 fixture（128×128，两种画面）', () => {
  const decoded = decodeGif(PIC_GIF_ANIM);
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 128);
  assert.equal(decoded.frameCount, 2);
  assert.equal(decoded.frames.length, 2);
  // 两帧必须是不同的画面，否则「拆帧」等于白做。
  assert.notDeepEqual(pixel(decoded.frames[0], 1, 1), pixel(decoded.frames[1], 1, 1));
  // 静图 GIF 只有一帧：调用方据此跳过拼图。
  assert.equal(decodeGif(PIC_GIF).frameCount, 1);
});

test('GIF 解码：畸形/越界输入抛错而不是挂住或吃内存', () => {
  assert.throws(() => inspectGif(Buffer.from('not a gif at all')), /GIF/);
  assert.throws(() => inspectGif(Buffer.from('GIF89a')), /GIF/);
  // 声明了 5000×5000 的逻辑屏幕：单边超限，直接拒绝，绝不能去申请 100MB。
  const huge = Buffer.alloc(13);
  huge.write('GIF89a', 0, 'latin1');
  huge.writeUInt16LE(5000, 6);
  huge.writeUInt16LE(5000, 8);
  huge[10] = 0x80;
  assert.throws(() => inspectGif(huge), /太大|像素/);
  // 合法头 + 被截断的图像块。
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [{ width: 4, height: 4, indices: Array(16).fill(0) }],
  });
  assert.throws(() => inspectGif(gif.subarray(0, 20)), /GIF/);
});
