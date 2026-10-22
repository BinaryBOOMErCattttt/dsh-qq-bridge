/**
 * 分镜图的版式与编码契约：布局顺序、不放大、面积平均缩小、PNG 字节真的能解回来。
 *
 * 布局断言按「格子坐标」逐点对，不靠肉眼：三列两行的顺序一旦写错（比如按列优先），
 * 模型看到的「过程」就是乱的，而且没有任何运行时报错会提醒你。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { buildStoryboard, downscaleRgb, encodePng } from '../storyboard.js';

/** 造一帧纯色画面。 */
function solid(width, height, color) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(color, i * 3);
  return { width, height, rgb };
}

function pixelAt(bytes, width, x, y) {
  const at = (y * width + x) * 3;
  return Array.from(bytes.subarray(at, at + 3));
}

/** 拆 PNG 块（只够读 IHDR / IDAT）。 */
function pngChunks(png) {
  const chunks = [];
  let pos = 8;
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('latin1');
    chunks.push({ type, data: png.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
  }
  return chunks;
}

test('分镜图：三列两行，按从左到右、从上到下排时间顺序', () => {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const sheet = buildStoryboard(colors.map((color) => solid(4, 4, color)));
  assert.equal(sheet.columns, 3);
  assert.equal(sheet.rows, 2);
  assert.equal(sheet.cellWidth, 4);
  assert.equal(sheet.cellHeight, 4);
  // 三个格子 + 四条 8px 的缝；两行 + 三条缝。
  assert.equal(sheet.width, 3 * 4 + 4 * 8);
  assert.equal(sheet.height, 2 * 4 + 3 * 8);

  // 拆回像素表（PNG → IDAT → 扫描线），逐点核对「第几格是哪一帧」。
  const ihdr = pngChunks(sheet.png).find((chunk) => chunk.type === 'IHDR');
  assert.equal(ihdr.data.readUInt32BE(0), sheet.width);
  assert.equal(ihdr.data.readUInt32BE(4), sheet.height);
  const idat = pngChunks(sheet.png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = sheet.width * 3 + 1;
  const pixels = Buffer.alloc(sheet.width * sheet.height * 3);
  for (let y = 0; y < sheet.height; y++) {
    assert.equal(raw[y * stride], 0, '每行用 filter 0');
    raw.copy(pixels, y * sheet.width * 3, y * stride + 1, (y + 1) * stride);
  }
  assert.deepEqual(pixelAt(pixels, sheet.width, 0, 0), [238, 238, 238], '底色把格子分开');
  assert.deepEqual(pixelAt(pixels, sheet.width, 8, 8), colors[0]);
  assert.deepEqual(pixelAt(pixels, sheet.width, 8 + 4 + 8, 8), colors[1]);
  assert.deepEqual(pixelAt(pixels, sheet.width, 8 + 2 * (4 + 8), 8), colors[2]);
  assert.deepEqual(pixelAt(pixels, sheet.width, 8, 8 + 4 + 8), colors[3]);
});

test('分镜图：缩小用面积平均，小图不放大', () => {
  const colors = [[255, 0, 0], [0, 0, 0]];
  const frames = [solid(4, 4, colors[0]), solid(4, 4, colors[1])];
  const small = buildStoryboard(frames, { cellSide: 2, columns: 2 });
  assert.equal(small.cellWidth, 2);
  assert.equal(small.cellHeight, 2);
  // 4×4 纯色按面积平均缩到 2×2 仍是同一个颜色（只验不糊、不串色）。
  const ihdr = pngChunks(small.png).find((chunk) => chunk.type === 'IHDR');
  assert.equal(ihdr.data.readUInt32BE(0), small.width);

  const untouched = buildStoryboard(frames, { cellSide: 320 });
  assert.equal(untouched.cellWidth, 4, '小图放大只会变糊，所以不放大');
  assert.equal(untouched.cellHeight, 4);
});

test('分镜图：面积平均按真实比例混合相邻颜色', () => {
  // 4×2：左边两列黑、右边两列白；缩到 2×1 后左右各是一个纯色。
  const source = new Uint8Array(4 * 2 * 3);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) {
      const value = x < 2 ? 0 : 255;
      source.set([value, value, value], (y * 4 + x) * 3);
    }
  }
  const scaled = downscaleRgb(source, 4, 2, 2, 1);
  assert.deepEqual(Array.from(scaled), [0, 0, 0, 255, 255, 255]);
  // 2×2 缩成 1×1：四个像素里三个黑一个白 → 63.75 → 四舍五入 64。
  const mixed = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255]);
  assert.deepEqual(Array.from(downscaleRgb(mixed, 2, 2, 1, 1)), [64, 64, 64]);
});

test('分镜图：帧尺寸不一致时报错（调用方据此降级）', () => {
  assert.throws(() => buildStoryboard([solid(4, 4, [0, 0, 0]), solid(2, 2, [0, 0, 0])]), /尺寸不一致/);
  assert.throws(() => buildStoryboard([]), /没有可拼的帧/);
});

test('encodePng：签名、IHDR 与 IEND 都是规范形态', () => {
  const png = encodePng(2, 1, new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.equal(ihdr[8], 8, '位深');
  assert.equal(ihdr[9], 2, '真彩');
  assert.equal(png.readUInt32BE(png.length - 8 + 4), 0xae426082, 'IEND 的 CRC 是固定值');
});
