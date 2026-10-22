/**
 * GIF 解码：把一整个动图拆成「按时间顺序的整幅画面」。
 *
 * 为什么自己写：QQ 里到处都是「动画表情」（GIF），而模型的图片入口只能收**单帧** ——
 * 宿主的附件层会给动图重新编码（`dsh-attachment-local` 的 `normalizeImage`：带
 * `animated` 的图一律走 sharp 重编码，只有单帧静图才原样放行），于是模型永远只看得到
 * 第一帧。要让它「看见」动图，只能在入站这边先拆帧、拼成一张分镜图（见 `storyboard.js`）。
 *
 * 为什么不用现成的库：这个插件是零运行时依赖 + 无构建步骤的（见 AGENTS.md §1），
 * 而 GIF 的 LZW 与帧合成规则本身不长，手写一份比多一个依赖划算。真正的坑只有两个：
 *   - LZW 的码是**低位在前**打包的（`perceptual.js` 里那段解码器已经踩过一遍）；
 *   - 帧不是「一整张图」，而是逻辑屏幕上的一个矩形，还带「处置方式」（disposal）：
 *     画完保留 / 擦成背景 / 还原成画之前的样子。合成时漏掉 disposal，拆出来的帧就会
 *     带上一层叠影 —— 那些只改了一小块区域的动图（打字机、光标闪烁）全靠它。
 *
 * 一切输入都当成不可信字节（QQ 那头没人守着），所以尺寸、帧数、像素预算都有硬上限，
 * 越界直接抛错，由调用方降级成「没有分镜图」而不是拖死进程。
 *
 * @module qq-bridge/gif
 */

/** 逻辑屏幕单边上限：超过它直接拒绝，别为一张畸形图申请几十 MB。 */
const MAX_SIDE = 4096;

/** 单帧像素上限（与 `perceptual.js` 同口径：2M 像素逐像素处理约 150ms）。 */
const MAX_FRAME_PIXELS = 2_000_000;

/** 一次解码最多累计处理多少个像素（含被跳过的帧，合成必须逐帧走）。 */
const DEFAULT_DECODED_PIXEL_BUDGET = 40_000_000;

/** 没写延时的帧按 100ms 算：浏览器就是这么兜底的，照抄才和用户看到的节奏一致。 */
const DEFAULT_DELAY_MS = 100;

/** 跳过一个 GIF 子块链（长度字节 + 数据，0 结束）；返回链后的位置，越界时 undefined。 */
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
 * 收集一个子块链的数据（LZW 压缩数据就是这么存的）。
 *
 * 单块时直接 `subarray`（零拷贝）：动图的压缩数据加起来就是整个文件大小，
 * 每个帧再复制一份没必要。
 * @returns `{ data, next }`；链没写完时 undefined。
 */
function collectSubBlocks(bytes, pos) {
  const parts = [];
  let total = 0;
  let at = pos;
  while (at < bytes.length) {
    const size = bytes[at];
    at += 1;
    if (size === 0) break;
    if (at + size > bytes.length) return undefined;
    parts.push(bytes.subarray(at, at + size));
    total += size;
    at += size;
  }
  if (at > bytes.length) return undefined;
  return { data: parts.length === 1 ? parts[0] : Buffer.concat(parts, total), next: at };
}

/**
 * 读一张调色板（每个颜色 3 字节）。
 * @param size - 条目数，必须与块里声明的一致。
 * @returns 字节视图；越界时 undefined。
 */
function readPalette(bytes, pos, size) {
  if (pos + size * 3 > bytes.length) return undefined;
  return bytes.subarray(pos, pos + size * 3);
}

/**
 * GIF 的 LZW 解码。
 *
 * 与 `perceptual.js` 里那份的差别：这里**允许解不满**（先写多少算多少，剩下的当透明）。
 * 真实动图里有不少帧尾被裁掉的（体积优化过的表情包），为此整张分镜图都放弃不值得；
 * 指纹那边要求逐字节精确，所以它保持严格。
 *
 * @param data - 拼好的压缩数据。
 * @param minCodeSize - 最小码长（2…8）。
 * @param limit - 期望解出的索引数（帧的像素数）。
 * @returns `{ indices, written }`；数据坏到读不下去时 `indices` 为 undefined。
 */
function decodeLzw(data, minCodeSize, limit) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const indices = new Uint8Array(limit);
  const stack = new Uint8Array(4096);
  let written = 0;
  let bitPos = 0;
  let previous = -1;
  let first = 0;
  const totalBits = data.length * 8;
  const readCode = () => {
    if (bitPos + codeSize > totalBits) return -1;
    let code = 0;
    // GIF 的码是低位在前：第一个读到的位是这个码的最低位。见 perceptual.js 的同名注释。
    for (let i = 0; i < codeSize; i++) {
      const at = bitPos + i;
      code |= ((data[at >> 3] >> (at & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return code;
  };
  while (written < limit) {
    const code = readCode();
    if (code < 0) break; // 数据提前结束：算「没解满」，不当作错误。
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) return { indices: undefined, written: 0 };
      first = code;
      indices[written++] = code;
      previous = code;
      continue;
    }
    let depth = 0;
    let current = code;
    if (current >= next) {
      // KwKwK：新串 = 上一个串 + 它的首字节。
      if (current > next) return { indices: undefined, written: 0 };
      stack[depth++] = first;
      current = previous;
    }
    while (current >= clear) {
      if (depth >= 4096 || current >= next) return { indices: undefined, written: 0 };
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
      indices[written++] = stack[--depth];
    }
    previous = code;
  }
  return { indices, written };
}

/**
 * 只解析结构、不解像素：帧数、每帧的矩形 / 延时 / 处置方式 / 调色板 / 压缩数据。
 *
 * 拆成两步是因为「要不要分镜」和「抽哪几帧」都得先知道帧数与总时长；对静图
 * （绝大多数表情包）连一次 LZW 都不该跑。
 *
 * @param bytes - 完整 GIF 字节（GIF87a / GIF89a）。
 * @returns `{ width, height, frameCount, durationMs, loop, frames }`，`frames[i]` 的
 *   `data` 是这一帧的 LZW 压缩数据（子块拼好的视图）。
 * @throws 不是 GIF、尺寸/像素越界、结构坏到读不下去时。
 */
export function inspectGif(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 13) throw new Error('不是 GIF 文件');
  const header = bytes.subarray(0, 6).toString('latin1');
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('不是 GIF 文件');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width <= 0 || height <= 0) throw new Error(`GIF 尺寸非法 (${width}x${height})`);
  if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`GIF 太大 (${width}x${height})`);
  if (width * height > MAX_FRAME_PIXELS) throw new Error(`GIF 像素太多 (${width}x${height})`);

  const packed = bytes[10];
  let pos = 13;
  let globalPalette;
  if (packed & 0x80) {
    const entries = 1 << ((packed & 7) + 1);
    globalPalette = readPalette(bytes, pos, entries);
    if (globalPalette === undefined) throw new Error('GIF 调色板被截断');
    pos += entries * 3;
  }

  const frames = [];
  let loop;
  // 图形控制扩展只作用于**紧跟着的那一帧**，读完就清空（规范如此，别复用到下一帧）。
  let control = { delayMs: 0, disposal: 0, transparent: -1 };
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) break; // trailer
    if (pos + 1 >= bytes.length) throw new Error('GIF 结构被截断');
    if (block === 0x21) {
      const label = bytes[pos + 1];
      if (label === 0xf9) {
        // [块长=4][flags][延时 2 字节(1/100 秒)][透明色索引][结束 0]
        if (pos + 2 >= bytes.length || bytes[pos + 2] !== 4) throw new Error('GIF 图形控制块非法');
        if (pos + 7 >= bytes.length) throw new Error('GIF 结构被截断');
        const flags = bytes[pos + 3];
        control = {
          disposal: (flags >> 2) & 7,
          delayMs: bytes.readUInt16LE(pos + 4) * 10,
          transparent: flags & 0x01 ? bytes[pos + 6] : -1,
        };
      } else if (label === 0xff) {
        // 应用扩展：只认 NETSCAPE2.0 的循环次数，别的（XMP、注释）一律跳过。
        if (pos + 2 < bytes.length && bytes[pos + 2] === 11 && bytes.subarray(pos + 3, pos + 14).toString('latin1') === 'NETSCAPE2.0') {
          const sub = pos + 14;
          if (sub + 3 < bytes.length && bytes[sub] === 3 && bytes[sub + 1] === 1) loop = bytes.readUInt16LE(sub + 2);
        }
      }
      const next = skipSubBlocks(bytes, pos + 2);
      if (next === undefined) throw new Error('GIF 扩展块被截断');
      pos = next;
      continue;
    }
    if (block !== 0x2c) throw new Error(`GIF 里出现未知块 0x${block.toString(16)}`);
    if (pos + 10 > bytes.length) throw new Error('GIF 图像描述块被截断');
    const left = bytes.readUInt16LE(pos + 1);
    const top = bytes.readUInt16LE(pos + 3);
    const frameWidth = bytes.readUInt16LE(pos + 5);
    const frameHeight = bytes.readUInt16LE(pos + 7);
    const imagePacked = bytes[pos + 9];
    pos += 10;
    if (frameWidth <= 0 || frameHeight <= 0) throw new Error('GIF 帧尺寸非法');
    if (frameWidth * frameHeight > MAX_FRAME_PIXELS) throw new Error(`GIF 单帧像素太多 (${frameWidth}x${frameHeight})`);
    let palette = globalPalette;
    if (imagePacked & 0x80) {
      const entries = 1 << ((imagePacked & 7) + 1);
      palette = readPalette(bytes, pos, entries);
      if (palette === undefined) throw new Error('GIF 局部调色板被截断');
      pos += entries * 3;
    }
    if (palette === undefined) throw new Error('GIF 没有调色板');
    if (pos >= bytes.length) throw new Error('GIF 结构被截断');
    const minCodeSize = bytes[pos];
    if (minCodeSize < 2 || minCodeSize > 8) throw new Error(`GIF 的 LZW 码长非法 (${minCodeSize})`);
    const collected = collectSubBlocks(bytes, pos + 1);
    if (collected === undefined) throw new Error('GIF 图像数据被截断');
    frames.push({
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      interlaced: (imagePacked & 0x40) !== 0,
      palette,
      minCodeSize,
      data: collected.data,
      delayMs: control.delayMs,
      disposal: control.disposal,
      transparent: control.transparent,
    });
    pos = collected.next;
    control = { delayMs: 0, disposal: 0, transparent: -1 };
  }
  if (frames.length === 0) throw new Error('GIF 里没有画面');
  // 延时为 0 的帧按 100ms 算（浏览器就是这么兜底的）；50ms 这类真实短延时保持不变。
  const durationMs = frames.reduce((sum, frame) => sum + (frame.delayMs === 0 ? DEFAULT_DELAY_MS : frame.delayMs), 0);
  return { width, height, frameCount: frames.length, durationMs, loop, frames };
}

/** 透明画布：RGBA 全 0。合成期间保留 alpha，最后压到白底上（与聊天窗口的底色一致）。 */
function createCanvas(width, height) {
  return new Uint8Array(width * height * 4);
}

/**
 * 把一块矩形擦回透明（处置方式 2「还原成背景」）。
 *
 * 矩形可能越过逻辑屏幕（GIF 允许帧画在屏幕外，畸形文件更是随便写），所以这里按画布裁一刀，
 * 不能直接拿 `left + width` 去 fill —— 越界的区间会把相邻行也擦掉。
 */
function clearRect(canvas, canvasWidth, canvasHeight, rect) {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(canvasWidth, rect.left + rect.width);
  const bottom = Math.min(canvasHeight, rect.top + rect.height);
  if (right <= left || bottom <= top) return;
  for (let y = top; y < bottom; y++) {
    const row = y * canvasWidth;
    canvas.fill(0, (row + left) * 4, (row + right) * 4);
  }
}

/**
 * 把一帧画到画布上（只覆盖它自己的矩形，透明索引跳过）。
 *
 * @param canvas - 逻辑屏幕大小的 RGBA 画布。
 * @param frame - `inspectGif` 给出的一帧。
 * @param canvasWidth - 逻辑屏幕宽度。
 * @param canvasHeight - 逻辑屏幕高度。
 */
function drawFrame(canvas, frame, canvasWidth, canvasHeight) {
  const { indices, written } = decodeLzw(frame.data, frame.minCodeSize, frame.width * frame.height);
  if (indices === undefined) throw new Error('GIF 的 LZW 数据损坏');
  if (written < frame.width * frame.height) {
    // 解不满：缺的部分当透明（见 decodeLzw 的注释）。别把半帧垃圾像素画上去。
    // 但解出来的部分仍然有价值，继续画。
  }
  // 隔行帧的行序：每 8 行取一行，再每 8 行、每 4 行、每 2 行补 —— 与 PNG 的 Adam7 不同，
  // 这里是 GIF 特有的四遍扫描（8/8/4/2）。
  const rows = frame.interlaced
    ? (() => {
        const order = [];
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let y = start; y < frame.height; y += step) order.push(y);
        }
        return order;
      })()
    : undefined;
  const palette = frame.palette;
  const transparent = frame.transparent;
  for (let i = 0; i < written; i++) {
    const x = frame.left + (i % frame.width);
    const y = frame.top + (rows === undefined ? Math.floor(i / frame.width) : rows[Math.floor(i / frame.width)]);
    if (x >= canvasWidth || y >= canvasHeight) continue;
    const index = indices[i];
    if (index === transparent) continue;
    const at = index * 3;
    if (at + 2 >= palette.length) continue;
    const to = (y * canvasWidth + x) * 4;
    canvas[to] = palette[at];
    canvas[to + 1] = palette[at + 1];
    canvas[to + 2] = palette[at + 2];
    canvas[to + 3] = 255;
  }
}

/** 透明画布 → 白底 RGB（分镜图不带 alpha：附件层反正会把它压成 sRGB 单帧）。 */
function flattenToRgb(canvas, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, out = 0; i < canvas.length; i += 4, out += 3) {
    const alpha = canvas[i + 3] / 255;
    rgb[out] = Math.round(canvas[i] * alpha + 255 * (1 - alpha));
    rgb[out + 1] = Math.round(canvas[i + 1] * alpha + 255 * (1 - alpha));
    rgb[out + 2] = Math.round(canvas[i + 2] * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

/**
 * 挑出要拼进分镜图的帧下标。
 *
 * 为什么不是「前 6 帧」：表情包的关键往往在最后一帧（反转的那一下），只取开头
 * 等于还是没看到故事。这里在**整段**上均匀取，首尾一定包含。
 *
 * 像素预算：合成必须逐帧走（上一帧没擦掉的像素会留在画布上），所以真正解码的帧数
 * 由 `maxDecodedPixels` 限住；超了就把窗口裁到前面一段并标记 `truncated`，
 * 让占位符能老实说「只截了前 N 帧」。
 *
 * @param info - `inspectGif` 的结果。
 * @param options - `{ maxFrames, maxDecodedPixels }`。
 * @returns `{ indices, truncated, window }`：`indices` 升序、去重；`window` 是实际参与
 *   抽样的帧数（≤ 总帧数）。
 */
export function planFrameSample(info, { maxFrames = 6, maxDecodedPixels = DEFAULT_DECODED_PIXEL_BUDGET } = {}) {
  const total = info?.frameCount ?? 0;
  if (total <= 0) return { indices: [], truncated: false, window: 0 };
  const perFrame = Math.max(1, info.width * info.height);
  const budgetFrames = Math.max(1, Math.floor((Number.isFinite(maxDecodedPixels) && maxDecodedPixels > 0 ? maxDecodedPixels : DEFAULT_DECODED_PIXEL_BUDGET) / perFrame));
  const window = Math.min(total, budgetFrames);
  const wanted = Math.max(1, Math.min(Math.floor(maxFrames), window));
  if (wanted === 1) return { indices: [0], truncated: window < total, window };
  const indices = [];
  for (let k = 0; k < wanted; k++) {
    const index = Math.round((k * (window - 1)) / (wanted - 1));
    if (indices[indices.length - 1] !== index) indices.push(index);
  }
  return { indices, truncated: window < total, window };
}

/**
 * 这一帧能不能独立解出来（不依赖前面帧留在画布上的像素）。
 *
 * 判据是「不透明 + 铺满整块逻辑屏幕」：这样的帧会把画布上每一格都改写一遍，之前画了什么
 * 都不影响结果。表情包绝大多数都是这种整帧动画，于是抽 6 帧只要解 6 帧 —— 一个 60 帧的
 * 500×500 动图从 1.7 秒降到 0.2 秒（解码是同步的，会卡住整个插件的事件循环）。
 */
function isSelfContained(frame, width, height) {
  return frame.left === 0
    && frame.top === 0
    && frame.width === width
    && frame.height === height
    && frame.transparent < 0;
}

/**
 * 解码指定的若干帧（整幅画面，白底 RGB）。
 *
 * @param info - `inspectGif` 的结果。
 * @param indices - 升序的帧下标（`planFrameSample` 给出）。
 * @returns `[{ index, delayMs, width, height, rgb }]`。
 * @throws 某帧的 LZW 数据坏到读不下去时（调用方据此降级）。
 */
export function decodeGifFrames(info, indices) {
  const { width, height, frames } = info;
  const canvas = createCanvas(width, height);
  const wanted = [...new Set(indices)].filter((index) => Number.isInteger(index) && index >= 0 && index < frames.length).sort((a, b) => a - b);
  if (wanted.length === 0) return [];
  const last = wanted[wanted.length - 1];
  // 快路径：每一帧要的帧都不透明且铺满屏幕，谁先谁后都无所谓，各解各的。
  if (wanted.every((index) => isSelfContained(frames[index], width, height))) {
    return wanted.map((index) => {
      const frame = frames[index];
      const scratch = createCanvas(width, height);
      drawFrame(scratch, frame, width, height);
      return { index, delayMs: frame.delayMs, width, height, rgb: flattenToRgb(scratch, width, height) };
    });
  }
  const out = [];
  let cursor = 0;
  let saved;
  let previous;
  for (let i = 0; i <= last; i++) {
    // 先把上一帧的处置方式结清，再决定这一帧画完之后要不要留快照。
    if (previous !== undefined) {
      if (previous.disposal === 2) {
        clearRect(canvas, width, height, previous);
      } else if (previous.disposal === 3 && saved !== undefined) {
        canvas.set(saved);
      }
    }
    const frame = frames[i];
    saved = frame.disposal === 3 ? canvas.slice() : undefined;
    drawFrame(canvas, frame, width, height);
    previous = frame;
    if (cursor < wanted.length && wanted[cursor] === i) {
      out.push({ index: i, delayMs: frame.delayMs, width, height, rgb: flattenToRgb(canvas, width, height) });
      cursor += 1;
    }
  }
  return out;
}

/**
 * 一步到位：解析 + 抽帧 + 解码（`media.js` 用的就是它）。
 *
 * @param bytes - 完整 GIF 字节。
 * @param options - `{ maxFrames, maxDecodedPixels }`，含义见 `planFrameSample`。
 * @returns `{ width, height, frameCount, durationMs, truncated, frames }`；
 *   静图（只有 1 帧）时 `frames` 只有那一帧，调用方据此跳过拼图。
 * @throws 不是 GIF / 结构损坏 / 越界时（调用方降级成普通图片）。
 */
export function decodeGif(bytes, options = {}) {
  const info = inspectGif(bytes);
  const { indices, truncated } = planFrameSample(info, options);
  return {
    width: info.width,
    height: info.height,
    frameCount: info.frameCount,
    durationMs: info.durationMs,
    truncated,
    frames: decodeGifFrames(info, indices),
  };
}
