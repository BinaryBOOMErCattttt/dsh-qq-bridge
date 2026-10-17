/**
 * 图片指纹：回答「这两张图是不是同一张**画面**」—— 而不是「这两个文件是不是同一份字节」。
 *
 * 为什么需要它：QQ 会把同一张表情包**按发送者重新编码**。2026-10-13 那个群里最火的
 * 一张「寿来」就以三种字节形态出现过：
 *
 * ```
 * .qq-media/4b824078….jpg  94657 字节  progressive + Exif   （100000004 发）
 * .qq-media/8ba4c117….jpg 131307 字节  baseline + JFIF      （100000003 发）
 * .qq-media/78c09c54….jpg  79284 字节                        （100000005 发）
 * ```
 *
 * 三个文件两两 SSIM ≥ 0.985（画面就是同一张），但没有任何两份字节相同 —— 只按内容
 * 哈希认「同一张」，群里连着发同一张表情包时复读**永远**不会触发（见 docs/repeat.md「自动复读」）。
 *
 * 做法：把图缩成 16×16 灰度，取水平相邻像素的大小关系，得到 **dHash**（16×15 = 240 位）。
 * 同一张图重新编码后位差 0%~2%，同一套画风但文字不同的表情实测差 17% 以上
 * （4b824078… vs 587d1ea0…：dHash 差 17.2%，肉眼看是「寿来」和「萝莉来」两张），
 * 所以「位差 ≤ 8%」两边都有 2 倍余量；阈值由 `repeatImageTolerance` 配置，0 = 关掉画面比对。
 *
 * 三个刻意的取舍：
 *   - **零依赖、只解到「模糊得能认出是同一张」**：JPEG 只解 DC 系数（它正好是 8×8 块的
 *     平均亮度，本身就是一张 1/8 缩略图），PNG 用 `node:zlib` 解出像素，GIF 手写 LZW 取
 *     第一帧。不解 AC、不做完整解码、不还原透明通道 —— 指纹要的只是轮廓。
 *   - **输入一律当成不可信的字节**：尺寸、块数、扫描数、解压长度都有硬上限；畸形、截断、
 *     超限一律返回 undefined（调用方退化成「只认字节相同」）。这里绝不抛异常。
 *   - **不认识就不猜**：WebP、CMYK（4 分量）JPEG、隔行 PNG 这些解不动的直接返回
 *     undefined，而不是硬算一个可能错的指纹（宁可漏跟一次，也不要跟错一张图）。
 *
 * @module qq-bridge/perceptual
 */
import { inflateSync } from 'node:zlib';

/** 指纹网格边长：16×16 灰度、16×15 个水平比较 = 240 位。 */
const GRID = 16;

/** 单边像素上限（防「解压炸弹」：2 万 × 2 万的文件可以压缩到几百字节）。 */
const MAX_SIDE = 10000;

/**
 * PNG / GIF 的像素上限：这两条路是**逐像素**解码的（反过滤 + 算灰度），2M 像素约 150ms、
 * 一亿像素的「PNG 炸弹」足以把事件循环卡死，所以宁可不当它是表情包、不给指纹。
 * 4M ≈ 2000×2000，已经比任何表情包都大了。
 */
const MAX_PIXELS = 4_000_000;

/** JPEG 的像素上限可以宽得多：它只解 DC，代价是像素数的 1/64（真正的工作量由 MAX_BLOCKS 兜）。 */
const MAX_PIXELS_JPEG = 16_000_000;

/** 一次解码最多走多少个 8×8 块（JPEG）：16M 像素 / 64 = 25 万，留 2 倍余量。 */
const MAX_BLOCKS = 500_000;

/** 一张图最多处理多少个扫描（正常 JPEG 十几个；这是给畸形文件兜底）。 */
const MAX_SCANS = 256;

/** 把值夹进 0..255：指纹只要相对大小，夹紧比溢出安全。 */
function clampByte(value) {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return 0;
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/** 开头是不是给定魔数。 */
function startsWith(bytes, sig) {
  return bytes.length >= sig.length && bytes.toString('latin1', 0, sig.length) === sig;
}

// ---------------------------------------------------------------------------
// 缩略图与 dHash
// ---------------------------------------------------------------------------

/**
 * 盒式平均降采样到 `grid×grid`（忽略长宽比：同一张画面重新编码后长宽比不变，
 * 拉伸不影响可比性，却省掉「按长边对齐」的一堆边界）。
 * @param plane - 每像素（或每块）一个灰度值的平面。
 * @param width - 平面宽。
 * @param height - 平面高。
 * @param grid - 输出边长。
 * @returns 长度 `grid*grid` 的浮点数组（没有覆盖到的格子保持 0）。
 */
function downscale(plane, width, height, grid) {
  const out = new Float64Array(grid * grid);
  const counts = new Float64Array(grid * grid);
  if (width <= 0 || height <= 0) return out;
  for (let y = 0; y < height; y++) {
    const gy = Math.min(grid - 1, Math.floor((y * grid) / height));
    const row = y * width;
    const rowOut = gy * grid;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(grid - 1, Math.floor((x * grid) / width));
      out[rowOut + gx] += plane[row + x];
      counts[rowOut + gx] += 1;
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (counts[i] > 0) out[i] /= counts[i];
  }
  return out;
}

/**
 * 把像素平面按 8×8 块求平均，得到一张 1/8 缩略图。
 *
 * 为什么 PNG / GIF 也要走这一步：JPEG 那条路只能拿到 8×8 块的 DC（它天生就是 1/8
 * 缩略图），如果 PNG 直接用全分辨率做盒式降采样，同一张画面「一次以 JPEG 发、一次以
 * PNG 发」时两条路的平均窗口对不齐 —— 实测同一张「寿来」JPEG 版和 PNG 版差 5%~7%，
 * 而 362×290 的「萝莉来」甚至差 26%，那样跨格式根本认不出是同一张。统一先降到
 * 1/8 块平均，两条路的算子就一样了。
 *
 * @param plane - 像素平面。
 * @param width - 平面宽。
 * @param height - 平面高。
 * @returns `{ plane, width, height }`（块分辨率）。
 */
function blockAverage(plane, width, height) {
  // 只取**完整**的 8×8 块：右边/下边不满一块的那几列像素直接丢掉（不到 7 像素，
  // 丢掉比算错强）。JPEG 那边同样只取完整块 —— 那里的半块被编码器用黑色补齐过
  // （实测块均值能差一半），留着反而会把两条路搞得不一致。
  const blocksW = Math.floor(width / 8);
  const blocksH = Math.floor(height / 8);
  const out = new Float64Array(Math.max(0, blocksW * blocksH));
  if (blocksW <= 0 || blocksH <= 0) return { plane: out, width: 0, height: 0 };
  for (let by = 0; by < blocksH; by++) {
    for (let bx = 0; bx < blocksW; bx++) {
      let sum = 0;
      for (let y = by * 8; y < by * 8 + 8; y++) {
        const row = y * width;
        for (let x = bx * 8; x < bx * 8 + 8; x++) sum += plane[row + x];
      }
      out[by * blocksW + bx] = sum / 64;
    }
  }
  return { plane: out, width: blocksW, height: blocksH };
}

/**
 * 网格 → dHash 十六进制串：比较水平相邻格子，左边更亮记 1。
 * @param grid - {@link downscale} 的结果。
 * @param size - 网格边长。
 * @returns 定长十六进制串（`size*(size-1)/4` 个字符）。
 */
function dhashHex(grid, size) {
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const bit = grid[y * size + x + 1] > grid[y * size + x] ? 1 : 0;
      nibble = (nibble << 1) | bit;
      bits += 1;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  if (bits > 0) hex += (nibble << (4 - bits)).toString(16);
  return hex;
}

// ---------------------------------------------------------------------------
// JPEG：只解 DC 系数（= 8×8 块的平均亮度）
// ---------------------------------------------------------------------------

/**
 * JPEG 熵数据里的位读取器。
 *
 * 只做三件事：把 `0xFF00` 还原成一个 `0xFF`、遇到真 marker 就停下（返回 -1，不消费）、
 * 在重启间隔处丢掉填充位并吃掉 `RSTn`。所有异常都靠返回值表达，不抛异常。
 */
class BitReader {
  constructor(bytes, pos) {
    this.bytes = bytes;
    this.pos = pos;
    this.buffer = 0;
    this.count = 0;
  }

  /** 读一个字节；撞上 marker 或文件结束返回 -1。 */
  nextByte() {
    if (this.pos >= this.bytes.length) return -1;
    const byte = this.bytes[this.pos++];
    if (byte !== 0xff) return byte;
    if (this.pos >= this.bytes.length) return -1;
    let next = this.bytes[this.pos];
    while (next === 0xff) {
      this.pos += 1;
      if (this.pos >= this.bytes.length) return -1;
      next = this.bytes[this.pos];
    }
    if (next === 0x00) {
      this.pos += 1;
      return 0xff;
    }
    return -1; // 真 marker：不消费，交给调用方。
  }

  /** 读一位；没数据了返回 -1。 */
  bit() {
    if (this.count === 0) {
      const byte = this.nextByte();
      if (byte < 0) return -1;
      this.buffer = byte;
      this.count = 8;
    }
    this.count -= 1;
    return (this.buffer >> this.count) & 1;
  }

  /** 读 n 位；读不满返回 -1。 */
  bits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const one = this.bit();
      if (one < 0) return -1;
      value = (value << 1) | one;
    }
    return value;
  }

  /** 一个重启间隔结束：丢掉填充位，吃掉紧跟着的 `RSTn`。 */
  restart() {
    this.count = 0;
    if (this.pos + 1 >= this.bytes.length || this.bytes[this.pos] !== 0xff) return false;
    const marker = this.bytes[this.pos + 1];
    if (marker < 0xd0 || marker > 0xd7) return false;
    this.pos += 2;
    return true;
  }

  /** 跳过一段不关心的熵数据，直到下一个真 marker。 */
  skipToMarker() {
    while (this.pos + 1 < this.bytes.length) {
      if (this.bytes[this.pos] !== 0xff) {
        this.pos += 1;
        continue;
      }
      const next = this.bytes[this.pos + 1];
      if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
        this.pos += 2;
        continue;
      }
      return;
    }
    this.pos = this.bytes.length;
  }
}

/** 按 DHT 段建一张「长度<<16 | 码」→ 符号 的查找表。 */
function buildHuffmanTable(seg, offset) {
  if (offset + 17 > seg.length) return undefined;
  const counts = [];
  let total = 0;
  for (let i = 0; i < 16; i++) {
    counts.push(seg[offset + 1 + i]);
    total += counts[i];
  }
  if (total === 0 || offset + 17 + total > seg.length) return undefined;
  const symbols = seg.subarray(offset + 17, offset + 17 + total);
  const lookup = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      lookup.set((length << 16) | code, symbols[index]);
      index += 1;
      code += 1;
    }
    code <<= 1;
  }
  return { lookup, end: offset + 17 + total };
}

/** 从位流里读一个 Huffman 符号；失败返回 -1。 */
function readSymbol(reader, table) {
  if (table === undefined) return -1;
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    const one = reader.bit();
    if (one < 0) return -1;
    code = (code << 1) | one;
    const symbol = table.lookup.get((length << 16) | code);
    if (symbol !== undefined) return symbol;
  }
  return -1;
}

/** JPEG 的幅度扩展：s 位里读出来的 v 还原成带符号的差值。 */
function extendSign(value, size) {
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
}

/** 解析 SOF：尺寸、各分量的采样因子与量化表。 */
function parseFrame(seg, precision, width, height, count) {
  if (count < 1 || count > 3) return undefined; // 4 分量（CMYK/YCCK）不猜
  if (seg.length < 6 + count * 3) return undefined;
  if (precision !== 8) return undefined;
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return undefined;
  if (width * height > MAX_PIXELS_JPEG) return undefined;
  const comps = [];
  let maxH = 1;
  let maxV = 1;
  for (let i = 0; i < count; i++) {
    const h = seg[7 + i * 3] >> 4;
    const v = seg[7 + i * 3] & 15;
    if (h < 1 || v < 1 || h > 4 || v > 4) return undefined;
    comps.push({ id: seg[6 + i * 3], h, v, tq: seg[8 + i * 3], stride: 0, rows: 0 });
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
  }
  const mcuW = Math.ceil(width / (8 * maxH));
  const mcuH = Math.ceil(height / (8 * maxV));
  let blocks = 0;
  for (const comp of comps) blocks += mcuW * comp.h * (mcuH * comp.v);
  if (blocks > MAX_BLOCKS) return undefined;
  for (const comp of comps) {
    comp.stride = mcuW * comp.h;
    comp.rows = mcuH * comp.v;
  }
  return { width, height, comps, maxH, maxV, mcuW, mcuH };
}

/** 读一个块的 DC；顺序扫描里顺便把 AC 走一遍（只为让过位流，不存）。 */
function decodeBlock(reader, part, predictor, x, y, sequential, al) {
  const category = readSymbol(reader, part.dcTable);
  if (category < 0) return undefined;
  let diff = 0;
  if (category > 0) {
    const raw = reader.bits(category);
    if (raw < 0) return undefined;
    // 渐进 DC 首扫的「点变换」：差值要左移 Al 位再进预测器（T.81 G.1.2.2）。
    diff = extendSign(raw, category) << al;
  }
  const value = predictor + diff;
  const at = (y >> 3) * part.stride + (x >> 3);
  if (at >= 0 && at < part.dc.length) part.dc[at] = value;
  if (sequential) {
    let k = 1;
    while (k <= 63) {
      const rs = readSymbol(reader, part.acTable);
      if (rs < 0) return undefined;
      const run = rs >> 4;
      const size = rs & 15;
      if (size === 0) {
        if (run !== 15) break; // EOB
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) return undefined;
      if (reader.bits(size) < 0) return undefined;
      k += 1;
    }
  }
  return value;
}

/** 渐进 DC 精修：每个块一位。与 libjpeg 一致地按位或（负数是补码，语义相同）。 */
function refineBlock(reader, part, x, y, al) {
  const bit = reader.bit();
  if (bit < 0) return false;
  if (bit === 0) return true;
  const at = (y >> 3) * part.stride + (x >> 3);
  if (at >= 0 && at < part.dc.length) {
    // eslint-disable-next-line no-bitwise
    part.dc[at] |= 1 << al;
  }
  return true;
}

/**
 * 解一段扫描。
 *
 * 三种情况：顺序扫描（Se=63）读 DC + 走 AC；渐进 DC 首扫（Ss=Se=0, Ah=0）只读 DC；
 * 渐进 DC 精修（Ss=Se=0, Ah>0）每块一位。其它（AC 扫描）返回 `'skip'`，调用方跳过去。
 *
 * @returns `true` / `'skip'` / `false`（数据结构不对，放弃整个指纹）。
 */
function decodeScan(reader, scan, frame, pool, restartInterval) {
  const sequential = scan.se === 63;
  const dcFirst = scan.ss === 0 && scan.se === 0 && scan.ah === 0;
  const refine = scan.ss === 0 && scan.se === 0 && scan.ah > 0;
  if (!sequential && !dcFirst && !refine) return 'skip';
  if (scan.comps.length === 0) return false;

  const interleaved = scan.comps.length > 1;
  const parts = [];
  for (const entry of scan.comps) {
    const comp = frame.comps[entry.index];
    const dc = pool.dc[entry.index];
    if (comp === undefined || dc === undefined) return false;
    const part = {
      comp,
      dc,
      stride: comp.stride,
      dcTable: entry.dc === undefined ? undefined : pool.dcTables.get(entry.dc),
      acTable: entry.ac === undefined ? undefined : pool.acTables.get(entry.ac),
    };
    if (dcFirst && part.dcTable === undefined) return false;
    if (sequential && (part.dcTable === undefined || part.acTable === undefined || entry.index === undefined)) return false;
    parts.push(part);
  }

  const single = interleaved ? undefined : parts[0];
  if (single !== undefined && scan.ah === 0) {
    // 非交错扫描按该分量自己的块网格走（单分量 JPEG 时与交错网格一致）。
    const stride = Math.max(1, Math.ceil((frame.width * single.comp.h) / frame.maxH / 8));
    const rows = Math.max(1, Math.ceil((frame.height * single.comp.v) / frame.maxV / 8));
    if (stride > single.comp.stride || rows > single.comp.rows) return false;
    single.comp.stride = stride;
    single.comp.rows = rows;
    single.stride = stride;
  }

  const mcuW = single !== undefined ? single.comp.stride : Math.max(1, frame.mcuW);
  const totalMcus = interleaved ? frame.mcuW * frame.mcuH : single.comp.stride * single.comp.rows;
  if (totalMcus <= 0 || totalMcus > MAX_BLOCKS) return false;

  const predictors = parts.map(() => 0);
  for (let mcu = 0; mcu < totalMcus; mcu++) {
    if (interleaved) {
      const mcuX = mcu % frame.mcuW;
      const mcuY = Math.floor(mcu / frame.mcuW);
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        for (let by = 0; by < part.comp.v; by++) {
          for (let bx = 0; bx < part.comp.h; bx++) {
            const x = (mcuX * part.comp.h + bx) * 8;
            const y = (mcuY * part.comp.v + by) * 8;
            if (refine) {
              if (!refineBlock(reader, part, x, y, scan.al)) return false;
            } else {
              const value = decodeBlock(reader, part, predictors[p], x, y, sequential, scan.al);
              if (value === undefined) return false;
              predictors[p] = value;
            }
          }
        }
      }
    } else {
      const x = (mcu % single.comp.stride) * 8;
      const y = Math.floor(mcu / single.comp.stride) * 8;
      if (refine) {
        if (!refineBlock(reader, single, x, y, scan.al)) return false;
      } else {
        const value = decodeBlock(reader, single, predictors[0], x, y, sequential, scan.al);
        if (value === undefined) return false;
        predictors[0] = value;
      }
    }
    if (restartInterval > 0 && (mcu + 1) % restartInterval === 0 && mcu + 1 < totalMcus) {
      if (!reader.restart()) return false;
      for (let p = 0; p < predictors.length; p++) predictors[p] = 0;
    }
  }
  return true;
}

/**
 * JPEG → 灰度块平面（块分辨率，块值 = 该 8×8 块的平均亮度）。
 * @returns `{ plane, width, height }` 或 undefined。
 */
function jpegGray(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const quant = new Map();
  const dcTables = new Map();
  const acTables = new Map();
  let frame;
  let pool;
  let restartInterval = 0;
  let scans = 0;
  let pos = 2;

  const ensurePool = () => {
    if (frame === undefined) return false;
    if (pool !== undefined) return true;
    const dc = frame.comps.map((comp) => new Int32Array(comp.stride * comp.rows));
    pool = { dc, dcTables, acTables };
    return true;
  };

  while (pos + 1 < bytes.length && scans < MAX_SCANS) {
    if (bytes[pos] !== 0xff) {
      pos += 1; // 标记之间不该有别的东西，容错跳过
      continue;
    }
    let marker = bytes[pos + 1];
    while (marker === 0xff && pos + 2 < bytes.length) {
      pos += 1;
      marker = bytes[pos + 1];
    }
    if (marker === 0xff) break;
    pos += 2;
    if (marker === 0xd9) break; // EOI
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 1 >= bytes.length) break;
    const len = (bytes[pos] << 8) | bytes[pos + 1];
    if (len < 2 || pos + len > bytes.length) break;

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (len < 8) break;
      const seg = bytes.subarray(pos + 2, pos + len);
      frame = parseFrame(seg, seg[0], (seg[3] << 8) | seg[4], (seg[1] << 8) | seg[2], seg[5]);
      if (frame === undefined) return undefined;
      pos += len;
      continue;
    }
    if (marker === 0xdb) {
      const seg = bytes.subarray(pos + 2, pos + len);
      let at = 0;
      while (at < seg.length && quant.size < 8) {
        const pq = seg[at] >> 4;
        const tq = seg[at] & 15;
        at += 1;
        const need = pq === 0 ? 64 : 128;
        if (at + need > seg.length) break;
        const values = new Float64Array(64);
        for (let i = 0; i < 64; i++) {
          values[i] = pq === 0 ? seg[at + i] : (seg[at + i * 2] << 8) | seg[at + i * 2 + 1];
        }
        quant.set(tq, values);
        at += need;
      }
      pos += len;
      continue;
    }
    if (marker === 0xc4) {
      const seg = bytes.subarray(pos + 2, pos + len);
      let at = 0;
      while (at + 17 <= seg.length) {
        const tc = seg[at] >> 4;
        const th = seg[at] & 15;
        const table = buildHuffmanTable(seg, at);
        if (table === undefined) break;
        (tc === 0 ? dcTables : acTables).set(th, table);
        at = table.end;
      }
      pos += len;
      continue;
    }
    if (marker === 0xdd) {
      if (len < 4) break;
      restartInterval = (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += len;
      continue;
    }
    if (marker === 0xda) {
      if (len < 6) break;
      const seg = bytes.subarray(pos + 2, pos + len);
      const count = seg[0];
      if (seg.length < 1 + count * 2 + 3) break;
      const comps = [];
      let bad = false;
      for (let i = 0; i < count; i++) {
        const id = seg[1 + i * 2];
        const index = frame === undefined ? -1 : frame.comps.findIndex((comp) => comp.id === id);
        if (index < 0) {
          bad = true;
          break;
        }
        comps.push({ index, dc: seg[2 + i * 2] >> 4, ac: seg[2 + i * 2] & 15 });
      }
      const ss = seg[1 + count * 2];
      const se = seg[2 + count * 2];
      const ah = seg[3 + count * 2] >> 4;
      const al = seg[3 + count * 2] & 15;
      if (bad || !ensurePool()) return undefined;
      const scan = { comps, ss, se, ah, al };
      const reader = new BitReader(bytes, pos + len);
      const result = ss !== 0 || (se !== 0 && se !== 63)
        ? 'skip'
        : decodeScan(reader, scan, frame, pool, restartInterval);
      scans += 1;
      if (result === 'skip') {
        reader.skipToMarker();
        pos = reader.pos;
        continue;
      }
      if (result !== true) return undefined;
      pos = reader.pos;
      continue;
    }
    pos += len; // APPn / COM / 其它：按长度跳过
  }

  if (frame === undefined || pool === undefined) return undefined;
  const luma = frame.comps[0];
  const stride = luma.stride;
  // 同样只取完整块（见 blockAverage）：JPEG 的半块带着编码器的黑色补齐，
  // 块均值能差一倍，留着只会让「同一张画面的 JPEG 版和 PNG 版」对不上。
  const blocksW = Math.min(stride, Math.floor(frame.width / 8));
  const blocksH = Math.min(luma.rows, Math.floor(frame.height / 8));
  if (blocksW <= 0 || blocksH <= 0) return undefined;
  const table = quant.get(luma.tq);
  const q0 = table === undefined ? 1 : table[0];
  const plane = new Float64Array(blocksW * blocksH);
  for (let y = 0; y < blocksH; y++) {
    for (let x = 0; x < blocksW; x++) {
      const at = y * stride + x;
      const dc = at < pool.dc[0].length ? pool.dc[0][at] : 0;
      // DC 反量化值 / 8 = 这一块的平均亮度（JPEG 直流分量的定义），再加电平位移 128。
      plane[y * blocksW + x] = clampByte(128 + (dc * q0) / 8);
    }
  }
  // 有数据：这里已经是 8×8 块平均，不用再降一次（见 blockAverage）。
  return { plane, width: blocksW, height: blocksH, blocked: true };
}

// ---------------------------------------------------------------------------
// PNG：zlib 解压 + 反过滤，取灰度
// ---------------------------------------------------------------------------

/**
 * 把带透明度的采样按**白底**合成。
 *
 * 为什么是白底：透明背景的贴纸（GIF 的透明索引、PNG 的 alpha=0）在聊天窗口里就是
 * 露出发言区的浅色底 —— 实测同一个 950×950 的透明 GIF，不合成的话背景是一整片黑，
 * 和它自己的 JPEG/PNG 版本差到 MAD 190，指纹直接对不上；按白底合成后与 ffmpeg 解出来
 * 的画面一致。三个格式（PNG-α / GIF 透明索引 / 不透明的 JPEG）也因此口径统一。
 *
 * @param value - 已算好的灰度（0..255）。
 * @param alpha - 该像素的不透明度（0..255）。
 * @returns 合成到白底之后的灰度。
 */
function overWhite(value, alpha) {
  if (!(alpha < 255)) return value;
  return (value * alpha) / 255 + (255 * (255 - alpha)) / 255;
}

/** PNG 的 Paeth 预测器（过滤类型 4）。 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

/** 反过滤一行（就地）；`bpp` 是「一个像素占几个字节」，至少 1。 */
function unfilterRow(filter, row, prev, bpp) {
  const length = row.length;
  if (filter === 1) {
    for (let i = bpp; i < length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
    return;
  }
  if (filter === 2) {
    for (let i = 0; i < length; i++) row[i] = (row[i] + prev[i]) & 0xff;
    return;
  }
  if (filter === 3) {
    for (let i = 0; i < length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
    }
    return;
  }
  if (filter === 4) {
    for (let i = 0; i < length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      row[i] = (row[i] + paeth(left, prev[i], upLeft)) & 0xff;
    }
  }
}

/** 灰度 PNG 的 tRNS 颜色键：2 字节就是那个「透明的灰度值」。 */
function keyedOut(transparency, value) {
  if (transparency === undefined || transparency.length < 2) return false;
  const key = (transparency[0] << 8) | transparency[1];
  return Math.round(value) === key;
}

/**
 * RGB PNG 的 tRNS 颜色键：6 字节 = 那个「透明的 RGB」（16 位图里每个通道两个字节，
 * 和 `sample` 一样只取高字节）。
 * @returns 命中透明色时为 true。
 */
function keyedOutRgb(transparency, row, base, depth) {
  if (transparency === undefined || transparency.length < 6) return false;
  for (let i = 0; i < 3; i++) {
    const value = row[base + i];
    const key = depth === 16 ? transparency[i * 2] : transparency[i];
    if (value !== key) return false;
  }
  return true;
}

/** PNG → 灰度平面。隔行（Adam7）与不认识的色型返回 undefined。 */
function pngGray(bytes) {
  if (!startsWith(bytes, '\x89PNG\r\n\x1a\n')) return undefined;
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette;
  let transparency;
  const idat = [];
  let sawHeader = false;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    if (length > 0x7fffffff || pos + 12 + length > bytes.length) return undefined;
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      if (data.length < 13) return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      if (data[10] !== 0 || data[11] !== 0) return undefined; // 压缩/过滤方式必须标准
      interlace = data[12];
      sawHeader = true;
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!sawHeader || idat.length === 0) return undefined;
  if (interlace !== 0) return undefined;
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return undefined;
  if (width * height > MAX_PIXELS) return undefined;
  const channels = color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (channels === 0) return undefined;
  if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8 && depth !== 16) return undefined;
  if (depth !== 8 && depth !== 16 && color !== 0 && color !== 3) return undefined;
  if (depth === 16 && color === 3) return undefined;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const expected = (rowBytes + 1) * height;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return undefined;
  }
  if (raw.length < expected) return undefined;
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const maxValue = (1 << depth) - 1;
  const plane = new Uint8Array(width * height);
  // 两行缓冲区轮换：反过滤要用上一行，但没必要每行都重新分配一次。
  let prev = Buffer.alloc(rowBytes);
  let current = Buffer.alloc(rowBytes);
  const sample = (row, index) => {
    // `index` 是「第几个采样值」，bitAt 是它在行里的**位**偏移；8/16 位要换算回字节。
    const bitAt = index * depth;
    if (depth === 8 || depth === 16) return row[bitAt >> 3]; // 16 位取高字节：指纹不需要那个精度
    const shift = 8 - depth - (bitAt % 8);
    return (row[bitAt >> 3] >> shift) & maxValue;
  };
  const grayOf = (row, index) => (depth === 16 ? sample(row, index) : (sample(row, index) * 255) / maxValue);
  const lumaOf = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) return undefined;
    raw.copy(current, 0, y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    unfilterRow(filter, current, prev, bpp);
    const row = current;
    current = prev;
    prev = row;
    for (let x = 0; x < width; x++) {
      let value;
      if (color === 0) {
        // tRNS 对灰度图是一个「透明颜色键」：命中的像素按白底算。
        const gray = grayOf(row, x);
        value = keyedOut(transparency, gray) ? 255 : gray;
      } else if (color === 4) {
        value = overWhite(grayOf(row, x * 2), grayOf(row, x * 2 + 1));
      } else if (color === 2 || color === 6) {
        const base = color === 2 ? x * 3 : x * 4;
        const luma = lumaOf(grayOf(row, base), grayOf(row, base + 1), grayOf(row, base + 2));
        if (color === 6) {
          value = overWhite(luma, grayOf(row, base + 3));
        } else {
          value = keyedOutRgb(transparency, row, base, depth) ? 255 : luma;
        }
      } else {
        const index = sample(row, x);
        const at = index * 3;
        value = palette !== undefined && at + 2 < palette.length
          ? lumaOf(palette[at], palette[at + 1], palette[at + 2])
          : 0;
        // 调色板 PNG 的 tRNS 是「每个索引一个 alpha」。
        if (transparency !== undefined && index < transparency.length) value = overWhite(value, transparency[index]);
      }
      plane[y * width + x] = clampByte(value);
    }
  }
  return { plane, width, height };
}

// ---------------------------------------------------------------------------
// GIF：手写 LZW，取第一帧
// ---------------------------------------------------------------------------

/** 跳过 GIF 的子块链（长度字节 + 数据，0 结束）；返回新位置或 undefined。 */
function skipSubBlocks(bytes, pos) {
  while (pos < bytes.length) {
    const size = bytes[pos];
    pos += 1;
    if (size === 0) return pos;
    pos += size;
    if (pos > bytes.length) return undefined;
  }
  return undefined;
}

/**
 * GIF 的 LZW 解码。
 *
 * @param data - 拼好的压缩数据。
 * @param minCodeSize - 最小码长。
 * @param limit - 最多解出多少字节（帧的像素数）。
 * @returns 索引数组；数据坏了返回 undefined。
 */
function lzwIndices(data, minCodeSize, limit) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const out = new Uint8Array(limit);
  const stack = new Uint8Array(4096);
  let written = 0;
  let bitPos = 0;
  let previous = -1;
  let first = 0;
  const totalBits = data.length * 8;
  const readCode = () => {
    if (bitPos + codeSize > totalBits) return -1;
    // GIF 的 LZW 码**低位在前**打包：第一个读到的位是这个码的最低位，字节内部也从
    // bit0 开始消费 —— 拿真 GIF 的头两个字节 `00 ff` 一试就知道：9 位的 clear 码
    // 256 正好是「byte0 的 8 位全 0」加「byte1 的 bit0 = 1」。
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const at = bitPos + i;
      code |= ((data[at >> 3] >> (at & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return code;
  };
  while (written < limit) {
    const code = readCode();
    if (code < 0) return undefined;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) return undefined;
      first = code;
      out[written++] = code;
      previous = code;
      continue;
    }
    let depth = 0;
    let current = code;
    if (current >= next) {
      // KwKwK：新串 = 上一个串 + 它的首字节。
      if (current > next) return undefined;
      stack[depth++] = first;
      current = previous;
    }
    while (current >= clear) {
      if (depth >= 4096 || current >= next) return undefined;
      stack[depth++] = suffix[current];
      current = prefix[current];
    }
    first = suffix[current];
    stack[depth++] = first;
    if (next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    while (depth > 0) {
      if (written >= limit) break;
      out[written++] = stack[--depth];
    }
    previous = code;
  }
  return written === limit ? out : undefined;
}

/** GIF 的第一帧 → 灰度平面（透明像素按调色板颜色算，指纹够用）。 */
function gifGray(bytes) {
  if (!startsWith(bytes, 'GIF87a') && !startsWith(bytes, 'GIF89a')) return undefined;
  if (bytes.length < 13) return undefined;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return undefined;
  if (width * height > MAX_PIXELS) return undefined;
  const flags = bytes[10];
  let pos = 13;
  let palette;
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1));
    if (pos + size > bytes.length) return undefined;
    palette = bytes.subarray(pos, pos + size);
    pos += size;
  }
  const lumaOf = (pal, at) => (pal[at] * 77 + pal[at + 1] * 150 + pal[at + 2] * 29) >> 8;
  /** 图形控制扩展里给出的透明色索引（-1 = 没有透明色）。 */
  let transparent = -1;

  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) return undefined; // 文件结束了还没见到图像
    if (block === 0x21) {
      if (pos + 1 >= bytes.length) return undefined;
      const label = bytes[pos + 1];
      const dataPos = pos + 2;
      // 图形控制扩展（0xF9）：[块长=4][flags][延时 2][透明色索引][结束 0]
      if (label === 0xf9 && dataPos + 6 <= bytes.length && bytes[dataPos] === 4 && bytes[dataPos + 1] & 0x01) {
        transparent = bytes[dataPos + 4];
      }
      const nextPos = skipSubBlocks(bytes, dataPos);
      if (nextPos === undefined) return undefined;
      pos = nextPos;
      continue;
    }
    if (block !== 0x2c) return undefined;
    pos += 1;
    if (pos + 9 > bytes.length) return undefined;
    const left = bytes.readUInt16LE(pos);
    const top = bytes.readUInt16LE(pos + 2);
    const frameW = bytes.readUInt16LE(pos + 4);
    const frameH = bytes.readUInt16LE(pos + 6);
    const imageFlags = bytes[pos + 8];
    pos += 9;
    let framePalette = palette;
    if (imageFlags & 0x80) {
      const size = 3 * (1 << ((imageFlags & 7) + 1));
      if (pos + size > bytes.length) return undefined;
      framePalette = bytes.subarray(pos, pos + size);
      pos += size;
    }
    if (framePalette === undefined) return undefined;
    if (frameW <= 0 || frameH <= 0 || frameW * frameH > MAX_PIXELS) return undefined;
    if (left >= MAX_SIDE || top >= MAX_SIDE) return undefined;
    if (pos >= bytes.length) return undefined;
    const minCodeSize = bytes[pos];
    pos += 1;
    if (minCodeSize < 2 || minCodeSize > 8) return undefined;
    const parts = [];
    let dataLength = 0;
    let at = pos;
    while (at < bytes.length) {
      const size = bytes[at];
      at += 1;
      if (size === 0) break;
      if (at + size > bytes.length) return undefined;
      parts.push(bytes.subarray(at, at + size));
      dataLength += size;
      at += size;
    }
    const indices = lzwIndices(Buffer.concat(parts, dataLength), minCodeSize, frameW * frameH);
    if (indices === undefined) return undefined;
    // 画布默认按白底：帧比逻辑屏幕小的 GIF（实测有一张 160×150 的帧只有 137×117），
    // 没被帧覆盖的地方就是透明的，填 0（黑）会和它自己的 JPEG 版差到 MAD 85。
    const plane = new Uint8Array(width * height).fill(255);
    const rows = [];
    if (imageFlags & 0x40) {
      for (const step of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = step[0]; y < frameH; y += step[1]) rows.push(y);
      }
    } else {
      for (let y = 0; y < frameH; y++) rows.push(y);
    }
    for (let i = 0; i < indices.length; i++) {
      const x = left + (i % frameW);
      const y = top + rows[Math.floor(i / frameW)];
      if (x >= width || y >= height) continue;
      const index = indices[i];
      if (index === transparent) {
        plane[y * width + x] = 255; // 透明像素按白底算（见 overWhite）
        continue;
      }
      const atPalette = index * 3;
      plane[y * width + x] = atPalette + 2 < framePalette.length ? clampByte(lumaOf(framePalette, atPalette)) : 0;
    }
    return { plane, width, height };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 按魔数把字节解成灰度平面（不认识或解不动时 undefined）。
 *
 * 导出只为让单元测试能直接盯住三个解码器的输出（尺寸、块平均、第一帧），
 * 生产代码只用 {@link perceptualHash}。
 * @param bytes - 图片字节。
 * @returns `{ plane, width, height }` 或 undefined。
 */
export function imageGrayPlane(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return undefined;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegGray(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngGray(bytes);
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return gifGray(bytes);
    return undefined; // WebP / BMP / …：不认识就不猜
  } catch {
    return undefined;
  }
}

/**
 * 算一张图的感知指纹。
 *
 * @param bytes - 图片字节（任意来源，一律当成不可信输入）。
 * @param options - `{ grid }`：网格边长，默认 16。
 * @returns 定长十六进制指纹串；格式不支持、数据畸形、超出上限时 undefined。
 */
export function perceptualHash(bytes, { grid = GRID } = {}) {
  const size = Number.isFinite(grid) && grid >= 4 && grid <= 64 ? Math.floor(grid) : GRID;
  const gray = imageGrayPlane(bytes);
  if (gray === undefined || gray.width <= 0 || gray.height <= 0) return undefined;
  // JPEG 给的已经是 1/8 块平均；PNG / GIF 是像素，先统一降到 1/8 块平均再比，
  // 否则同一张画面 JPEG 版和 PNG 版会因为平均窗口不一样而认不出来（见 blockAverage）。
  const base = gray.blocked === true ? gray : blockAverage(gray.plane, gray.width, gray.height);
  // 缩略图比指纹网格还小的时候不硬撑：64×64 的图只有 8×8 个块，放大到 16×16 后相邻
  // 格子大量相等，两张完全不同的图会被算成同一张。宁可没有指纹（那就只认字节相同）。
  // 换算到原图就是「短边不到约 128 像素不给指纹」。
  if (base.width < size || base.height < size) return undefined;
  const cells = downscale(base.plane, base.width, base.height, size);
  // 整张图几乎一个颜色（纯色图、1×1 图）没有可辨认的画面：给指纹只会让「任何两张
  // 纯色图都算同一张」，所以同样退化成 undefined（按字节比）。
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] < min) min = cells[i];
    if (cells[i] > max) max = cells[i];
  }
  if (!(max - min >= 8)) return undefined;
  return dhashHex(cells, size);
}

/**
 * 两个指纹的位差比例（0 = 每一位都一样，1 = 每一位都不同）。
 * 长度不一致、任一为空都返回 1（= 判成不同），调用方不必自己判空。
 * @param left - {@link perceptualHash} 的结果。
 * @param right - 另一个指纹。
 * @returns `0..1`。
 */
export function hashDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return 1;
  if (left.length === 0 || left.length !== right.length) return 1;
  let differing = 0;
  let total = 0;
  for (let i = 0; i < left.length; i++) {
    const a = parseInt(left[i], 16);
    const b = parseInt(right[i], 16);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
    let xor = a ^ b;
    while (xor > 0) {
      differing += xor & 1;
      xor >>= 1;
    }
    total += 4;
  }
  return total === 0 ? 1 : differing / total;
}
