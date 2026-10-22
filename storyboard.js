/**
 * 动图分镜图：把抽出来的几帧拼成一张静图，再编码成 PNG。
 *
 * 为什么是「一张拼图」而不是「每帧一个文件」：模型读图是一个显式动作（`read_image`），
 * 给六个路径它多半只读第一个；而分镜图一次就读到完整的时间顺序。代价是每格分辨率低，
 * 对「看懂这个表情包在干嘛」这件事够用。
 *
 * 为什么不带帧号文字：画字要字体文件（又一个依赖 + 中文字形问题），而占位符里一句
 * 「从左到右、从上到下」已经说清顺序了。宁可少画，不要多一个渲染不了中文的位图字体。
 *
 * PNG 编码也在这里：零依赖，`node:zlib` 的 deflate 加上 5 个块就够，没必要为一张
 * 中间产物再引一个库。
 *
 * @module qq-bridge/storyboard
 */
import { deflateSync } from 'node:zlib';

import { decodeGifFrames, inspectGif, planFrameSample } from './gif.js';

/** 每格最长边（像素）：六格拼起来约 1000px 宽，附件层不会再压一轮。 */
const DEFAULT_CELL_SIDE = 320;

/** 一张分镜图最多拼几帧：三列两行，够看出「开头 → 结尾」的那一下转折。 */
const DEFAULT_FRAMES = 6;

/** 最多几列：三列时 6 帧正好两行，读起来是按时间顺序的「Z」字。 */
const DEFAULT_COLUMNS = 3;

/** 格间距（像素）：底色是浅灰，靠这道缝把相邻两帧分开。 */
const GAP = 8;

/** 拼图底色：刻意不用纯白 —— 白色表情包和背景融在一起时，边界就没了。 */
const BACKGROUND = 238;

/** PNG 的 CRC32 查表（一次建好，之后每块查表）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 一个 PNG 块：长度 + 类型 + 数据 + CRC（CRC 算在「类型 + 数据」上）。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * 8 位真彩（无 alpha）PNG 编码。
 *
 * 每行前缀一个 filter 字节 0（None）：分镜图是「几块照片拼起来」的合成图，
 * 逐行过滤省不了多少，反而多一遍 CPU。
 *
 * @param width - 像素宽。
 * @param height - 像素高。
 * @param rgb - 长度 `width * height * 3` 的字节。
 * @returns 完整 PNG 字节。
 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：真彩
  ihdr[10] = 0; // 压缩方式：deflate
  ihdr[11] = 0; // 过滤方式：自适应
  ihdr[12] = 0; // 不隔行

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 面积平均缩小（每个目标像素取源图一块矩形里所有像素的均值）。
 *
 * 为什么不用最近邻：表情包常被缩到 1/3 以下，最近邻会丢掉细线和小字，分镜图本来就小，
 * 再丢细节就只剩色块了。
 *
 * @param rgb - 源图字节（`srcWidth * srcHeight * 3`）。
 * @returns 目标尺寸的字节（`dstWidth * dstHeight * 3`）。
 */
export function downscaleRgb(rgb, srcWidth, srcHeight, dstWidth, dstHeight) {
  const out = new Uint8Array(dstWidth * dstHeight * 3);
  for (let y = 0; y < dstHeight; y++) {
    const sy0 = Math.floor((y * srcHeight) / dstHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * srcHeight) / dstHeight));
    for (let x = 0; x < dstWidth; x++) {
      const sx0 = Math.floor((x * srcWidth) / dstWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * srcWidth) / dstWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let at = (sy * srcWidth + sx0) * 3;
        for (let sx = sx0; sx < sx1; sx++) {
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
          at += 3;
          count += 1;
        }
      }
      const to = (y * dstWidth + x) * 3;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
    }
  }
  return out;
}

/**
 * 一张动图 → 一张分镜图（解析、抽帧、拼图、编码一次做完）。
 *
 * 入站媒体和「已收藏的表情」都要它：前者落盘时顺手写一份，后者在后台扫目录时补一份。
 * 静图（只有一帧）返回 undefined —— 调用方据此跳过，不为一张不动的图多写一个文件。
 *
 * @param bytes - 完整 GIF 字节。
 * @param options - `{ maxFrames, cellSide }`，含义见 `planFrameSample` / `buildStoryboard`。
 * @returns `{ png, width, height, frames, durationMs, shown, truncated }`；静图时 undefined。
 * @throws 不是 GIF / 结构损坏 / 越界时（调用方降级成普通图片）。
 */
export function storyboard(bytes, { maxFrames = DEFAULT_FRAMES, cellSide = DEFAULT_CELL_SIDE } = {}) {
  const info = inspectGif(bytes);
  if (info.frameCount <= 1) return undefined;
  const plan = planFrameSample(info, { maxFrames });
  const sheet = buildStoryboard(decodeGifFrames(info, plan.indices), { cellSide });
  return {
    png: sheet.png,
    width: sheet.width,
    height: sheet.height,
    frames: info.frameCount,
    durationMs: info.durationMs,
    shown: plan.indices.length,
    truncated: plan.truncated,
  };
}

/**
 * 把若干帧拼成一张分镜图。
 *
 * 布局：按时间顺序、从左到右、从上到下；每格同尺寸（同一张动图的帧共享逻辑屏幕尺寸），
 * 不放大（小图放大只会变糊，模型不缺这几个像素）。
 *
 * @param frames - `[{ rgb, width, height }]`，至少 2 帧（静图不该走到这里）。
 * @param options - `{ cellSide, columns }`。
 * @returns `{ png, width, height, cellWidth, cellHeight, columns, rows }`。
 */
export function buildStoryboard(frames, { cellSide = DEFAULT_CELL_SIDE, columns = DEFAULT_COLUMNS } = {}) {
  const count = Array.isArray(frames) ? frames.length : 0;
  if (count === 0) throw new Error('没有可拼的帧');
  const first = frames[0];
  const sourceWidth = first.width;
  const sourceHeight = first.height;
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('帧尺寸非法');
  const side = Number.isFinite(cellSide) && cellSide > 0 ? Math.floor(cellSide) : DEFAULT_CELL_SIDE;
  // 不放大：scale 上限 1。
  const scale = Math.min(1, side / Math.max(sourceWidth, sourceHeight));
  const cellWidth = Math.max(1, Math.round(sourceWidth * scale));
  const cellHeight = Math.max(1, Math.round(sourceHeight * scale));
  const cols = Math.max(1, Math.min(Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_COLUMNS, count));
  const rows = Math.ceil(count / cols);
  const width = cols * cellWidth + (cols + 1) * GAP;
  const height = rows * cellHeight + (rows + 1) * GAP;

  const sheet = new Uint8Array(width * height * 3).fill(BACKGROUND);
  frames.forEach((frame, index) => {
    if (frame.width !== sourceWidth || frame.height !== sourceHeight) throw new Error('分镜图的帧尺寸不一致');
    const cell = frame.width === cellWidth && frame.height === cellHeight
      ? frame.rgb
      : downscaleRgb(frame.rgb, frame.width, frame.height, cellWidth, cellHeight);
    const left = GAP + (index % cols) * (cellWidth + GAP);
    const top = GAP + Math.floor(index / cols) * (cellHeight + GAP);
    for (let y = 0; y < cellHeight; y++) {
      const from = y * cellWidth * 3;
      sheet.set(cell.subarray(from, from + cellWidth * 3), ((top + y) * width + left) * 3);
    }
  });

  return { png: encodePng(width, height, sheet), width, height, cellWidth, cellHeight, columns: cols, rows };
}
