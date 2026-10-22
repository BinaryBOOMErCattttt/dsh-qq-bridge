/**
 * 已收藏的动图表情：给它们也补一张分镜图。
 *
 * 为什么需要单独一层：入站媒体（`media.js`）只在**别人刚发过来**时顺手拆帧；用户早就收藏进
 * `.qq-stickers/` 的那些 GIF 再也不会走那条路 —— 模型在目录里看到的是原文件，`read_image`
 * 读它只会拿到第一帧（宿主附件层对 GIF 统一重编码，见 `gif.js` 的文件头）。于是「这个表情
 * 是什么意思」这个问题，对已收藏的动图依然只能靠猜。
 *
 * 这里的做法：后台扫一遍收藏目录，把动图按内容哈希拆成 `<媒体目录>/sticker-frames/<哈希>.png`，
 * 记住「文件名 → 分镜图路径」；`sticker.js` 在渲染表情包目录时把这份对照表附在目录后面。
 *
 * 为什么不把分镜图放进 `.qq-stickers/` 自己：那个目录里每个图片文件都会被当成一张可发的
 * 表情（`stickerFiles` 只按扩展名筛），多出来的 `-frames.png` 会偷偷混进目录、还会占
 * `stickerMaxFiles` 的名额。放在媒体目录的子目录里还有两个好处：`prune()` 只扫顶层文件，
 * 不会把分镜图当普通缓存淘汰；内容哈希命名让改名 / 重复收藏自然复用同一张图。
 *
 * 为什么是后台扫描而不是渲染目录时现算：`stickerCatalogLines` 是同步的（每轮装配提示词都会
 * 跑），在里面解码几十张 GIF 会把整个事件循环卡住。扫描只在启动、存图、改名、目录变化时
 * 各跑一次，且每张图之间让出事件循环。
 *
 * @module qq-bridge/sticker-frames
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { inspectGif } from './gif.js';
import { insideDirectory } from './image.js';
import { storyboard } from './storyboard.js';

/** 分镜图在媒体目录里的子目录名（见文件头：不能放进表情包目录里）。 */
const SHEETS_DIR = 'sticker-frames';

/** 目录行里最多列几张动图：再多就把「本轮情境」撑成一份列表，收益却递减。 */
const MAX_LINES = 10;

/**
 * 建一份「已收藏动图 → 分镜图」的索引。
 *
 * @param options - `{ cwd, stickerDir, mediaDirectory, enabled, report }`。
 * @param options.cwd - 工作目录（沙箱根）。
 * @param options.stickerDir - 配置里的表情包目录（相对 cwd）；空串表示没配。
 * @param options.mediaDirectory - 媒体缓存目录（绝对路径）；分镜图落在它的子目录里。
 * @param options.enabled - 媒体下载总开关（`mediaDownload`）：关掉时整层停用，不写任何文件。
 * @param options.report - 日志回调 `(level, message)`。
 * @returns `{ refresh, refreshSoon, lines, signature }`。
 */
export function createStickerFrames({ cwd, stickerDir, mediaDirectory, enabled = true, report = () => {} } = {}) {
  const root = resolve(cwd ?? process.cwd());
  const raw = typeof stickerDir === 'string' ? stickerDir.trim() : '';
  const stickerRoot = raw.length > 0 ? resolve(root, raw) : undefined;
  // 与 `sticker.js` 同一条边界：目录必须在 cwd 里，否则模型读不到，列出来只会让它去撞一次错。
  const inside = stickerRoot !== undefined && insideDirectory(root, stickerRoot);
  const sheets = enabled === true && inside && typeof mediaDirectory === 'string' && mediaDirectory.length > 0
    ? join(resolve(mediaDirectory), SHEETS_DIR)
    : undefined;
  /** 分镜图的对外路径：相对 cwd、正斜杠 —— 模型就是照这个字符串调 `read_image`。 */
  const display = (target) => relative(root, target).split(sep).join('/');

  /** 文件名 → `{ path, frames }`；只收动图，静图不放进来。 */
  const known = new Map();
  let running;
  let again = false;

  /** 收藏目录里的 GIF 文件名（不递归、跳过隐藏文件）。 */
  async function listGifs() {
    if (stickerRoot === undefined || !inside) return [];
    const entries = await readdir(stickerRoot, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.gif$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** 扫一遍目录：补齐缺的分镜图、更新对照表、清掉不再对应的旧图。 */
  async function refresh() {
    if (sheets === undefined) return;
    const names = await listGifs();
    if (names.length === 0) {
      // 没有动图就连目录都不建：`mediaDir` 顶层的文件数被测试与运维当作缓存账本，
      // 一个空子目录会让「缓存里只有几张图」这件事对不上。
      known.clear();
      await dropOrphans(new Set());
      return;
    }
    await mkdir(sheets, { recursive: true }).catch(() => {});
    const next = new Map();
    const keep = new Set();
    for (const name of names) {
      try {
        const bytes = await readFile(join(stickerRoot, name));
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        const target = join(sheets, `${hash}.png`);
        keep.add(`${hash}.png`);
        const built = await readOrCreate(bytes, target);
        if (built !== undefined) next.set(name, { path: display(target), frames: built.frames });
      } catch (error) {
        // 单张图坏了只跳过它：一个坏文件不该让整份对照表消失。
        report('warn', `media: could not build the storyboard for sticker "${name}": ${error?.message ?? error}`);
      }
      // 每张之间让出事件循环：扫描可能连着解码十几张动图，别把收消息的链路卡住。
      await new Promise((resolve) => setImmediate(resolve));
    }
    known.clear();
    for (const [name, info] of next) known.set(name, info);
    await dropOrphans(keep);
    if (next.size > 0) report('info', `media: sticker storyboards ready (${next.size}/${names.length} animated)`);
  }

  /**
   * 分镜图已经存在就直接用（只解析帧数，不解码像素）；不存在才真的拆帧。
   * @returns `{ frames }` 或 undefined（静图）。
   */
  async function readOrCreate(bytes, target) {
    const info = inspectGif(bytes);
    if (info.frameCount <= 1) return undefined;
    const existing = await readFile(target).catch(() => undefined);
    if (existing !== undefined) return { frames: info.frameCount };
    const built = storyboard(bytes);
    if (built === undefined) return undefined;
    await writeFile(target, built.png);
    return { frames: built.frames };
  }

  /** 表情被删 / 换掉之后，缓存里的旧分镜图没有价值了：按这一轮见过的哈希清掉。 */
  async function dropOrphans(keep) {
    const entries = await readdir(sheets, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.png$/i.test(entry.name) || keep.has(entry.name)) continue;
      await unlink(join(sheets, entry.name)).catch(() => {});
    }
  }

  /** 排队一次扫描；扫描进行中时只留一个「还得再扫一次」的标记（存图后连发几条的情况）。 */
  function refreshSoon() {
    if (sheets === undefined) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    running = refresh()
      .catch((error) => report('warn', `media: sticker storyboard scan failed: ${error?.message ?? error}`))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          refreshSoon();
        }
      });
  }

  /**
   * 目录行（拼在表情包目录后面）。
   *
   * 只给「已经拆好」的那些：还没扫到的动图这一轮不出现，等扫描完下一次目录变化时补上
   * （`signature` 会跟着变，`sticker.js` 据此把目录再发一次）。
   *
   * @returns 一行说明；没有动图时空数组。
   */
  function lines() {
    if (known.size === 0) return [];
    const items = [...known.entries()].sort(([left], [right]) => left.localeCompare(right));
    const shown = items.slice(0, MAX_LINES);
    const rest = items.length - shown.length;
    const list = shown.map(([name, info]) => `${name}（${info.frames} 帧）→ ${info.path}`).join('、');
    return [
      `- 这些收藏的表情是动图（直接 read_image 原图只有第一帧，想看动作读后面的分镜图）：${list}${rest > 0 ? `，还有 ${rest} 张没列出来` : ''}。`,
    ];
  }

  /** 对照表的指纹：`sticker.js` 拿它当目录「要不要再发一次」的一部分。 */
  function signature() {
    return [...known.entries()].sort().map(([name, info]) => `${name}:${info.path}`).join('|');
  }

  return { refresh, refreshSoon, lines, signature, directory: sheets };
}
