/**
 * 出站图片 / 表情包：把「本地文件或 URL」变成能塞进 OneBot `image` 段的字节。
 *
 * 为什么走 `base64://` 而不是把本地路径交给 NapCat：NapCat 跑在容器里、插件跑在
 * 宿主机上，两边不是同一个文件系统 —— 交本地路径它读不到（README 里
 * `upload_private_file` 传路径被回「识别URL失败」是同一个原因，NapCat 的
 * `enableLocalFile2Url` 默认也是关的）。而 OneBot 的 image 段支持
 * `base64://<数据>`：NapCat 的 `Ti()`（发图/传文件共用的那个解析器）会把 base64
 * 解码写进它自己的临时目录，后续链路与 http 链接完全一样，而且不依赖「容器能不能
 * 连到宿主机」这个假设。代价是体积膨胀 4/3 —— 所以这里有字节上限（默认 8MB，
 * 远低于 NapCat 的 WebSocket `maxPayload`，实测那边是 50MB）。
 *
 * 与 media.js 的分工：那边是**入站**（QQ 的图 → 本地文件，给 `read_image` 看），
 * 这边是**出站**（本地文件/URL → QQ）。两边都只认 PNG/JPEG/WebP/GIF，都靠**魔数**
 * 而不是后缀判断，失败都只说人话、不抛字节层面的细节。
 *
 * @module qq-bridge/image
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBytes, sniffImageExtension } from './media.js';
import { pathInside } from './util.js';

/** 出站图片的默认字节上限（配置里可改）。 */
export const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 出站图片是 URL 时的默认下载超时（毫秒）。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 20000;

/** 把任意异常压成一句能写进工具错误/日志的短语。 */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/**
 * 目标路径是否在 `root` 里（`root` 自身也算）。
 *
 * 出站图片只允许发工作目录里的文件：QQ 那头是不可信输入，模型可能被群里的人
 * 指使去发 `/etc/passwd` 之类的东西 —— 虽然它有魔数校验，但「只读工作区」
 * 本来就是这个部署的沙箱边界，没理由为了发张图把它捅开。
 *
 * 实现搬到了 `util.js` 的 `pathInside`：这条判定不只服务出站图片，记忆目录、
 * 表情包目录的沙箱校验用的是同一条规矩（含 Windows 的大小写语义）。
 * 这里保留同名导出，是为了不让 `memory.js` / `index.js` 与既有测试跟着改一圈。
 * @param root - 已解析的绝对目录。
 * @param target - 已解析的绝对路径。
 * @returns 在范围内为 true。
 */
export function insideDirectory(root, target) {
  return pathInside(root, target);
}

/** 相对工作目录的展示路径（正斜杠），就是模型该把它写回来的那种写法。 */
function displayPath(root, target) {
  const path = relative(root, target).split(sep).join('/');
  return path.length > 0 ? path : '.';
}

/**
 * 把模型给的图片来源变成字节。
 *
 * 接受三种写法（都是模型真会写出来的）：
 *   - 相对工作目录的路径：`.qq-stickers/笑死.gif`、`.qq-media/ab12….jpg`；
 *   - 绝对路径或 `file://` URL —— 但**必须落在工作目录里**；
 *   - http(s) 链接：插件先把它下下来（顺便校验格式与大小），再交给 QQ。
 *
 * 只认 PNG/JPEG/WebP/GIF（部署的图片链路只认这四种），且靠魔数判断，
 * 所以 `.txt` 改名成 `.png` 也蒙不过去。
 *
 * @param options - 取图参数。
 * @param options.source - 图片路径或 URL（已 trim）。
 * @param options.cwd - 工作目录（沙箱根）：本地路径必须落在它里面。
 * @param options.maxBytes - 字节上限；超出直接失败，不做静默压缩。
 * @param options.timeoutMs - URL 下载超时。
 * @param options.fetchImpl - 下载实现，测试可注入。
 * @returns `{ bytes, format, source, label }`：字节、格式、原样的来源、给人看的来源摘要。
 * @throws 输入为空 / 越界 / 不是文件 / 太大 / 不是图片 / 下载失败时抛错（message 已说人话）。
 */
export async function loadOutgoingImage({
  source,
  cwd,
  maxBytes = DEFAULT_IMAGE_MAX_BYTES,
  timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const root = resolve(cwd ?? process.cwd());
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_IMAGE_MAX_BYTES;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_IMAGE_TIMEOUT_MS;
  const raw = String(source ?? '').trim();
  if (raw.length === 0) throw new Error('no image given: pass a file path inside the working directory or an http(s) URL');

  let bytes;
  let label;
  if (/^https?:\/\//i.test(raw)) {
    try {
      bytes = await fetchBytes(raw, { maxBytes: limit, timeoutMs: timeout, fetchImpl });
    } catch (error) {
      throw new Error(`could not download ${raw}: ${reasonOf(error)}`);
    }
    label = raw;
  } else {
    // 本地路径这一支。`file://` 先转成路径；其余带协议的写法（`ftp://`…）不猜，直接拒绝。
    let path;
    if (/^file:\/\//i.test(raw)) path = fileURLToPath(raw);
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      throw new Error(`unsupported image source "${raw.slice(0, 40)}": pass a file path inside the working directory or an http(s) URL`);
    } else path = raw;
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!insideDirectory(root, target)) {
      throw new Error(`image path must be inside the working directory (${root}): ${path}`);
    }
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`not a local file: ${path}`);
    if (info.size === 0) throw new Error(`empty file: ${path}`);
    if (info.size > limit) throw new Error(`image is larger than ${limit} bytes: ${path}`);
    bytes = await readFile(target);
    label = displayPath(root, target);
  }

  if (bytes.length === 0) throw new Error(`empty image: ${label}`);
  if (bytes.length > limit) throw new Error(`image is larger than ${limit} bytes: ${label}`);
  const format = sniffImageExtension(bytes);
  if (format === undefined) throw new Error(`not a PNG/JPEG/WebP/GIF image: ${label}`);
  return { bytes, format, source: raw, label };
}

/**
 * 组装 OneBot 的 `image` 消息段。
 *
 * 只给 `file`，不给 `url` —— NapCat 的发送侧按 `[url, file, path]` 取第一个有值的
 * 字段，把 base64 放在 `file` 里最不容易被别的实现误读成链接。
 * @param bytes - 图片字节。
 * @returns `{ type: 'image', data: { file: 'base64://…' } }`。
 */
export function imageSegment(bytes) {
  return { type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } };
}
