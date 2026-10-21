/**
 * QQ 消息里的图片/表情包 → Agent 能读的本地文件。
 *
 * 为什么需要这一层：OneBot 上报的 `image` 段里只有一串**会过期**的下载 URL
 * （腾讯的 `rkey` 有时效，实测 NapCat 给的就是 `multimedia.nt.qq.com.cn/download?…&rkey=…`），
 * 而 Agent 要「看见」图只能靠 `read_image` 读本地文件。这个模块把两者接起来：
 * 取字节 → 按魔数认出真正的格式 → 以内容哈希命名落进缓存目录 → 返回相对路径。
 *
 * 三个刻意的设计：
 *   - 只认 PNG/JPEG/WebP/GIF（`read_image` 与部署的附件服务只接受这四种），
 *     并且靠**魔数**而不是 URL 后缀判断 —— 腾讯的下载链接压根不带扩展名；
 *   - 文件名只取内容哈希，绝不用远端给的文件名（那是不可信输入，也可能是 `../../x`）；
 *   - 一切失败都降级成一句占位文本，绝不把异常抛回消息链路（QQ 那头是无人值守的）。
 *
 * @module qq-bridge/media
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 支持的图片格式：魔数判定 + 落盘用的扩展名。
 * 顺序有意义：JPEG 的魔数最短，但四种之间没有歧义，任意顺序都可。
 */
const IMAGE_FORMATS = [
  {
    ext: 'png',
    test: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  { ext: 'jpg', test: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  {
    ext: 'gif',
    test: (bytes) => bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a'),
  },
  {
    ext: 'webp',
    test: (bytes) =>
      bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** 下载超时、缓存条数等配置的兜底值（配置里填了非法值时用它）。 */
const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 200,
  timeoutMs: 15000,
  concurrency: 4,
};

/**
 * 按文件头判断图片格式。
 * @param bytes - 已下载/已读出的完整字节。
 * @returns `png` / `jpg` / `gif` / `webp`；认不出来时 undefined（调用方据此拒绝落盘）。
 */
export function sniffImageExtension(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  for (const format of IMAGE_FORMATS) {
    if (format.test(bytes)) return format.ext;
  }
  return undefined;
}

/**
 * 一个有上限的信号量。
 *
 * 并发下载数不能由 QQ 那头的消息量决定：同时来十条图消息，如果每个会话都立刻发起
 * 请求，就是对腾讯 CDN（以及我们自己的内存）的一次小型 DoS。超出的任务排队，而不是失败。
 * @param limit - 同时执行的任务数上限（非正数视为 1）。
 * @returns 形如 `(task) => Promise` 的执行器。
 */
function createLimiter(limit) {
  const width = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  let active = 0;
  const waiting = [];
  return async function run(task) {
    if (active >= width) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      // 唤醒下一个等待者（每次只放一个，`active` 的加减才配得平）。
      waiting.shift()?.();
    }
  };
}

/** 把任意异常/值转成一句可放进日志和占位文本的短语。 */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 按 HTTP(S) 下载字节：边收边算大小，超限立刻中止，超时直接放弃。
 *
 * 入站落盘（`createMediaStore`）与出站发图（`image.js`）共用这一份 ——
 * 「怎么把一个 URL 变成有上限的字节」只该有一种答案，两边的上限语义才不会有出入。
 *
 * 重定向一律自己跟（`redirect: 'manual'`）：这样每一跳都能先过 `validateUrl`。
 * 出站图片会把 `checkUrl` + DNS 解析的结果传进来；入站不带校验器，行为与以前一样
 * （最多 3 跳），因为 NapCat 给的图片地址有时就是本机地址。
 *
 * @param url - http / https 链接。
 * @param options - `{ maxBytes, timeoutMs, fetchImpl, validateUrl, maxRedirects }`；缺省即模块默认。
 * @param options.validateUrl - 可选的异步校验器：每一跳（含初始 URL）先调它，返回字符串时
 *   作为归一化后的下一跳地址；抛错即中止。
 * @returns 完整字节。
 * @throws 非法 URL、非 http(s)、重定向异常、HTTP 错误、空响应体、超时或超限时抛错。
 */
export async function fetchBytes(
  url,
  {
    maxBytes = DEFAULTS.maxBytes,
    timeoutMs = DEFAULTS.timeoutMs,
    fetchImpl = globalThis.fetch,
    validateUrl,
    maxRedirects = 3,
  } = {},
) {
  const byteCap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULTS.maxBytes;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULTS.timeoutMs;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${String(url).slice(0, 60)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported URL scheme ${parsed.protocol}`);
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeout}ms`)), timeout);
  timer.unref?.();
  try {
    let current = parsed;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (typeof validateUrl === 'function') {
        const checked = await validateUrl(current.href);
        if (typeof checked === 'string' && checked.length > 0) current = new URL(checked);
      }
      const response = await fetchImpl(current.href, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        try {
          await response.body?.cancel?.();
        } catch {
          // 3xx 的响应体没有用；取不取消不影响判定。
        }
        if (typeof location !== 'string' || location.trim().length === 0) {
          throw new Error(`redirect ${response.status} without a location`);
        }
        if (hop === maxRedirects) throw new Error(`too many redirects (${maxRedirects})`);
        let next;
        try {
          next = new URL(location.trim(), current.href);
        } catch {
          throw new Error('invalid redirect location');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`unsupported redirect scheme ${next.protocol}`);
        }
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > byteCap) throw new Error(`too large (${declared} bytes)`);
      if (response.body === null || response.body === undefined) throw new Error('empty response body');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > byteCap) {
          controller.abort(new Error('too large'));
          throw new Error(`larger than ${byteCap} bytes`);
        }
        chunks.push(bytes);
      }
      if (total === 0) throw new Error('empty response body');
      return Buffer.concat(chunks);
    }
    throw new Error(`too many redirects (${maxRedirects})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 `base64://…`、`data:image/png;base64,…` 或裸 base64。
 * @param text - OneBot 给的 base64 字段。
 * @returns 解码后的字节；明显不是 base64 时 undefined。
 */
function decodeBase64(text) {
  const raw = String(text ?? '').trim();
  const body = raw.replace(/^data:[^;,]+;base64,/i, '').replace(/^base64:\/\//i, '');
  if (body.length === 0 || !/^[A-Za-z0-9+/=\s]+$/.test(body)) return undefined;
  try {
    const bytes = Buffer.from(body, 'base64');
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 建立媒体缓存。
 *
 * @param options - 缓存参数。
 * @param options.cwd - Agent 的工作目录（也是沙箱根）：缓存目录必须落在它里面，
 *   Agent 的 `read_image` 才读得到。
 * @param options.dir - 缓存目录，相对 `cwd`。
 * @param options.maxBytes - 单个文件的字节上限。
 * @param options.maxFiles - 缓存最多保留几个文件（按最近使用时间淘汰最旧的）。
 * @param options.timeoutMs - 单次下载超时。
 * @param options.concurrency - 同时进行的下载数上限。
 * @param options.enabled - 关掉后 `resolve()` 一律返回失败原因，不做任何 I/O。
 * @param options.fetchImpl - 下载实现，测试可注入。
 * @param options.resolveViaOneBot - 兜底取字节的回调（index.js 接的是 `get_image`）。
 * @param options.report - 接收 `(level, message)` 的日志回调。
 * @returns `{ enabled, directory, resolve, prune }`。
 */
export function createMediaStore({
  cwd,
  dir = '.qq-media',
  maxBytes = DEFAULTS.maxBytes,
  maxFiles = DEFAULTS.maxFiles,
  timeoutMs = DEFAULTS.timeoutMs,
  concurrency = DEFAULTS.concurrency,
  enabled = true,
  fetchImpl = globalThis.fetch,
  resolveViaOneBot,
  report = () => {},
} = {}) {
  const root = resolve(cwd ?? process.cwd());
  const directory = resolve(root, dir.length > 0 ? dir : '.qq-media');
  const byteCap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULTS.maxBytes;
  const fileCap = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : DEFAULTS.maxFiles;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULTS.timeoutMs;
  // 缓存目录必须在 cwd 里：否则 Agent 的沙箱读不到，等于白下载；配置写错了就整体关掉，
  // 而不是把文件写到工作区外面去。
  const insideRoot = directory === root || directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  let active = enabled === true && insideRoot;
  if (enabled === true && !insideRoot) {
    report('warn', `mediaDir "${dir}" resolves outside cwd (${root}); media download is disabled`);
  }
  const run = createLimiter(concurrency);

  /** 缓存文件的对外路径：相对 cwd、正斜杠，直接可以喂给 read_image。 */
  function displayPath(target) {
    return relative(root, target).split(sep).join('/');
  }

  /** 从 HTTP(S) 下载，边收边算大小，超限立刻中止（上限与超时取自本 store 的配置）。 */
  function download(url) {
    return fetchBytes(url, { maxBytes: byteCap, timeoutMs: timeout, fetchImpl });
  }

  /** 读本机上已经存在的文件（共享卷、`disableGetUrl` 给的本地路径、`file://`）。 */
  async function readLocal(file) {
    let path = String(file ?? '').trim();
    if (path.length === 0) throw new Error('no local path');
    if (/^base64:\/\//i.test(path) || /^data:[^;,]+;base64,/i.test(path)) {
      const bytes = decodeBase64(path);
      if (bytes === undefined) throw new Error('malformed inline base64 image');
      return bytes;
    }
    if (/^file:\/\//i.test(path)) path = fileURLToPath(path);
    const target = isAbsolute(path) ? path : resolve(root, path);
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`not a local file: ${path}`);
    if (info.size === 0) throw new Error('empty file');
    if (info.size > byteCap) throw new Error(`too large (${info.size} bytes)`);
    return readFile(target);
  }

  /** 依次尝试各种取字节的途径，全部失败才报错（错误信息里带上每种原因）。 */
  async function loadBytes(media) {
    const attempts = [];
    if (typeof media.url === 'string' && media.url.length > 0) attempts.push(() => download(media.url));
    if (typeof media.file === 'string' && media.file.length > 0) attempts.push(() => readLocal(media.file));
    // 兜底：把 file 段原样丢回 OneBot 的 get_image —— 它可能回 base64，也可能回一个
    // 我们这边能用的 URL 或本地路径（rkey 过期、或 NapCat 与 Harness 不在同一台机器时）。
    if (typeof resolveViaOneBot === 'function' && typeof media.file === 'string' && media.file.length > 0) {
      attempts.push(async () => {
        const info = await resolveViaOneBot(media);
        if (info === undefined || info === null) throw new Error('onebot returned nothing');
        const inline = decodeBase64(info.base64);
        if (inline !== undefined) return inline;
        if (typeof info.url === 'string' && info.url.length > 0) return download(info.url);
        if (typeof info.file === 'string' && info.file.length > 0) return readLocal(info.file);
        throw new Error('onebot returned no usable bytes');
      });
    }
    if (attempts.length === 0) throw new Error('no downloadable source in this segment');
    const failures = [];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        failures.push(reasonOf(error));
      }
    }
    throw new Error(failures.join('; '));
  }

  /** 按最近使用时间淘汰旧文件，把缓存条数压回上限内。 */
  async function prune() {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // 目录还没建起来 = 没有东西要淘汰。
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(directory, entry.name);
      const info = await stat(full).catch(() => undefined);
      if (info !== undefined) files.push({ full, mtimeMs: info.mtimeMs });
    }
    if (files.length <= fileCap) return;
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const stale of files.slice(0, files.length - fileCap)) {
      await unlink(stale.full).catch(() => {});
    }
  }

  /**
   * 把一个媒体段落到本地缓存。
   * @param media - `collectMedia()` 给出的媒体描述（kind/label/url/file/declaredBytes…）。
   * @returns 成功时 `{ path, bytes, cached }`；失败时 `{ error }` —— 永不抛错。
   */
  async function resolveMedia(media = {}) {
    if (!active) return { error: 'media download is disabled' };
    if (typeof media.declaredBytes === 'number' && media.declaredBytes > byteCap) {
      return { error: `too large (${media.declaredBytes} bytes)` };
    }
    return run(async () => {
      try {
        const bytes = await loadBytes(media);
        const ext = sniffImageExtension(bytes);
        if (ext === undefined) throw new Error('not a PNG/JPEG/WebP/GIF image');
        // 内容哈希：同一张表情包被反复发的时候天然去重，也顺带挡掉了远端文件名的路径穿越。
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        const target = join(directory, `${hash}.${ext}`);
        await mkdir(directory, { recursive: true });
        const existing = await stat(target).catch(() => undefined);
        if (existing?.isFile()) {
          // 命中缓存也要刷新 mtime：它是 LRU 的「最近使用」依据。
          await utimes(target, new Date(), new Date()).catch(() => {});
        } else {
          await writeFile(target, bytes);
        }
        await prune();
        return { path: displayPath(target), bytes: bytes.length, cached: existing?.isFile() === true };
      } catch (error) {
        return { error: reasonOf(error) };
      }
    });
  }

  return { enabled: active, directory, resolve: resolveMedia, prune };
}
