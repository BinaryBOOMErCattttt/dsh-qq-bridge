/**
 * 测试用的 GIF 编码器（只够拼出「可预期的画面」，不是通用的编码库）。
 *
 * 为什么要在测试里现编 GIF：分镜图/拆帧的断言必须能逐像素对上 —— 用真实的网图当 fixture
 * 只能断言「解出来了、尺寸对」，而 disposal（画完保留 / 擦背景 / 还原）、隔行、透明索引
 * 这几条正好是最容易写错、也最该逐像素盯住的地方。
 *
 * LZW 故意编成「每个像素前面都发一个 clear 码」：解压器每次 clear 后码长都回到初始值，
 * 于是编码端不用维护字典，只要按固定码长把「clear、字面量、clear、字面量……」按
 * **低位在前**打包即可 —— 对解码器来说这是一份完全合法的流，只是压不紧。
 */

/** 把一串定长码按 GIF 的「低位在前」规则打包成字节。 */
function packCodes(codes, codeSize) {
  const bytes = [];
  let bit = 0;
  let current = 0;
  for (const code of codes) {
    for (let i = 0; i < codeSize; i++) {
      const value = (code >> i) & 1;
      current |= value << bit;
      bit += 1;
      if (bit === 8) {
        bytes.push(current);
        current = 0;
        bit = 0;
      }
    }
  }
  if (bit > 0) bytes.push(current);
  return Buffer.from(bytes);
}

/** 一帧的像素索引按 GIF 的隔行扫描顺序重排（编码端要做的事，与解码端互逆）。 */
function interlacedOrder(height) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

function colorTableSize(entries) {
  let size = 2;
  while (size < entries) size *= 2;
  return size;
}

function colorTableBytes(palette, size) {
  const bytes = Buffer.alloc(size * 3);
  palette.forEach((color, index) => {
    bytes[index * 3] = color[0];
    bytes[index * 3 + 1] = color[1];
    bytes[index * 3 + 2] = color[2];
  });
  return bytes;
}

function subBlocks(data) {
  const parts = [];
  for (let at = 0; at < data.length; at += 255) parts.push(data.subarray(at, at + 255));
  return Buffer.concat([...parts.flatMap((part) => [Buffer.from([part.length]), part]), Buffer.from([0])]);
}

/**
 * 拼一张 GIF。
 *
 * @param options - `{ width, height, palette, frames, loop }`。
 * @param options.palette - 全局调色板 `[[r,g,b], …]`；条目数会向上补到 2 的幂。
 * @param options.frames - 每帧 `{ left, top, width, height, indices, palette?, delayMs, disposal, transparent, interlaced }`；
 *   `indices` 是**按行优先**排好的像素索引（函数内部负责隔行重排）。
 * @param options.loop - 写不写 NETSCAPE 循环扩展；undefined 表示不写。
 * @returns 完整 GIF 字节。
 */
export function buildGif({ width, height, palette, frames, loop }) {
  const header = Buffer.from('GIF89a', 'latin1');
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  const globalSize = colorTableSize(palette.length);
  // 全局色表标志（bit7）+ 色表大小指数（bit0-2，条目数 = 2^(n+1)）+ 背景色索引 0。
  screen[4] = 0x80 | (Math.log2(globalSize) - 1);
  screen[5] = 0;
  screen[6] = 0;

  const parts = [header, screen, colorTableBytes(palette, globalSize)];
  if (loop !== undefined) {
    parts.push(Buffer.from([
      0x21, 0xff, 0x0b,
      ...Buffer.from('NETSCAPE2.0', 'latin1'),
      0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00,
    ]));
  }

  for (const frame of frames) {
    const localPalette = frame.palette;
    const localSize = localPalette === undefined ? 0 : colorTableSize(localPalette.length);
    // 局部色表写在**图像描述块之后**（规范顺序），别和全局色表的位置搞混。
    const tableSize = localPalette === undefined ? globalSize : localSize;
    const minCodeSize = Math.max(2, Math.log2(tableSize));
    const transparent = frame.transparent ?? -1;
    const disposal = frame.disposal ?? 0;
    // 存储单位是 1/100 秒；调用方按毫秒传，写盘时折算。
    const delay = Math.max(0, Math.round((frame.delayMs ?? 100) / 10));
    // 图形控制扩展：万一位深要到 8，minCodeSize 也是 8，这里只负责透明与处置方式。
    parts.push(Buffer.from([
      0x21, 0xf9, 0x04,
      ((disposal & 7) << 2) | (transparent >= 0 ? 1 : 0),
      delay & 0xff, (delay >> 8) & 0xff,
      transparent >= 0 ? transparent : 0,
      0x00,
    ]));

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(frame.left ?? 0, 1);
    descriptor.writeUInt16LE(frame.top ?? 0, 3);
    descriptor.writeUInt16LE(frame.width, 5);
    descriptor.writeUInt16LE(frame.height, 7);
    descriptor[9] = (localPalette !== undefined ? 0x80 | (Math.log2(localSize) - 1) : 0)
      | (frame.interlaced === true ? 0x40 : 0);
    parts.push(descriptor);
    if (localPalette !== undefined) parts.push(colorTableBytes(localPalette, localSize));

    const rows = frame.interlaced === true ? interlacedOrder(frame.height) : undefined;
    const ordered = rows === undefined
      ? frame.indices
      : rows.flatMap((y) => frame.indices.slice(y * frame.width, (y + 1) * frame.width));
    const clear = 1 << minCodeSize;
    const codes = [];
    for (const index of ordered) {
      codes.push(clear, index);
    }
    codes.push(clear, (1 << minCodeSize) + 1); // 末尾：clear + end
    const data = packCodes(codes, minCodeSize + 1);
    parts.push(Buffer.from([minCodeSize]), subBlocks(data));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
