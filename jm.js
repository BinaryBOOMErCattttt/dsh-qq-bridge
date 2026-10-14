/**
 * 禁漫（JM / 18comic）本子 → PDF → 发到 QQ。
 *
 * 为什么单独一个模块：这条链路和「QQ ↔ Agent」的消息桥接没有任何关系，它只是一件
 * 后台活儿 —— 起一个 python 子进程（jmcomic）把本子下下来、合并成 PDF，再把文件
 * 交给 OneBot 的 `upload_*_file` 发出去。桥接模块只负责「谁要的、发给谁」。
 *
 * 三个必须知道的现实约束（都是实测出来的，不是猜的）：
 *
 *   1. **NapCat 在容器里，插件在宿主机上**，两边看到的文件系统不是同一个 ——
 *      给 `upload_private_file` 传本地路径会被拒（`识别URL失败`，NapCat 的
 *      `enableLocalFile2Url` 默认还是关的）。所以这里起一个极小的 HTTP 服务，
 *      把 PDF 用**一次性 token 的 URL** 交给 NapCat 自己来取；服务只绑在
 *      docker 网桥上（默认 172.17.0.1），局域网 / 校园网都碰不到它。
 *   2. **PDF 必须落在 cwd 里**（和 mediaDir 同一条规矩）：写到工作区外面，Agent
 *      读不到、也不好排查；配置写错就整体停用，而不是偷偷写到别处。
 *   3. **下载可能很久**（整本几百话）也会失败（JM 抽风、域名更换、图片 403）。
 *      所以子进程有硬超时，输出走 JSON Lines 协议，任何失败都变成一句人话，绝不
 *      把异常抛回上层把 QQ 那头的等待吊死。
 *
 * @module qq-bridge/jm
 */
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { defaultJmFileHost, defaultJmPython } from './util.js';

/** 默认的 python 解释器位置（相对 cwd）：仓库自带的 venv，两条平台的布局不一样。 */
const DEFAULT_PYTHON = defaultJmPython();

/** 默认的下载目录（相对 cwd）。 */
const DEFAULT_DIR = '.qq-jm';

/** 一次下载的硬超时（毫秒）：整本几百话也就这个量级，再久就是卡死了。 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** NapCat 来取文件的 URL 有效期（毫秒）：够它排完队把文件拉走。 */
const DEFAULT_URL_TTL_MS = 10 * 60 * 1000;

/** 最多保留几个 PDF（按最近使用时间淘汰最旧的）。 */
const DEFAULT_MAX_FILES = 20;

/** 响应里带 ANSI 颜色，journal 里不好看，剥掉。 */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * 子进程的启动/终止方式在两条平台上**不是同一件事**，这里一次性判掉。
 *
 *   - POSIX：`detached: true` 让子进程自成进程组，超时时用 `process.kill(-pid)` 整组带走
 *     （jmcomic 会再开线程、偶尔起子进程，只杀主进程会留下孤儿占着网络与管道）。
 *   - Windows：`detached: true` 的语义是「**给子进程开一个新的控制台窗口**」—— 桌面版里
 *     就是每次下载弹一个黑框；而 `process.kill(-pid)` 在那边直接抛错（没有进程组信号）。
 *     所以那边不 detached、加 `windowsHide`，杀树交给 `taskkill /T`。
 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * 杀掉一个下载子进程**连同它的子孙**。
 *
 * POSIX 上子进程带 `detached: true` 起在自己的进程组里（jmcomic 会再开线程、甚至起
 * 子进程），只 kill 主进程会留下孤儿继续占着网络与管道 —— 实测那样会让测试进程一直
 * 等到孤儿退出为止，所以整组杀。
 *
 * Windows 上没有进程组信号，`process.kill(-pid)` 会直接抛错；`taskkill /T` 才是那边
 * 「连子孙一起杀」的等价物。它不 await：调用方（超时或关服务）要立刻往下走，子进程
 * 随后会自己发 `close` 事件。
 *
 * @param child - 已 spawn 的子进程。
 */
function killProcessTree(child) {
  if (child.pid === undefined) return;
  if (IS_WINDOWS) {
    try {
      spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
}

/**
 * 从一段文本里认出禁漫车号。
 *
 * 支持四种写法，都是群里真会出现的：
 *   - `422866`              纯车号（本子 id 或某一话的 id，交给 auto 判）
 *   - `JM422866` / `jm422866`
 *   - `https://18comic.vip/album/422866/`  → 整本
 *   - `https://18comic.vip/photo/422866/`  → 单话
 *
 * @param text - 待解析的一段文本（可以带 URL 后缀、query、#锚点）。
 * @returns `{ kind, id }`；解析不出来时 undefined。`kind` 为 `album` / `chapter` / `auto`。
 */
export function parseJmRef(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return undefined;
  // 链接优先：路径里的 album / photo 直接决定「整本」还是「单话」。
  const url = raw.match(/https?:\/\/[^\s]*?\/(album|photo|photos|chapter)\/(\d+)/i);
  if (url !== null) {
    return { kind: /album/i.test(url[1]) ? 'album' : 'chapter', id: url[2] };
  }
  const tagged = raw.match(/^(?:jm|JM|Jm)[\s_:-]*(\d{3,})\b/);
  if (tagged !== null) return { kind: 'auto', id: tagged[1] };
  const bare = raw.match(/^(\d{3,})\b/);
  if (bare !== null) return { kind: 'auto', id: bare[1] };
  return undefined;
}

/**
 * 把任意标题清成安全的文件名（Node 侧的兜底；python 侧也会清一次）。
 *
 * PDF 名最终来自远端返回的标题 —— 那是**不可信输入**，可能带 `/`、`..`、
 * 控制字符。这里只保留可打印字符并限长，拼路径前还会再做一次包含性校验。
 *
 * @param raw - 原始标题。
 * @param fallback - 清完为空时的退路。
 * @returns 安全文件名（不含扩展名）。
 */
export function safeFileName(raw, fallback = 'jm') {
  const name = String(raw ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return name.length > 0 ? name : fallback;
}

/** 把任意失败转成一句能发给 QQ 的短话。 */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 一个有上限的信号量：并发下载数不能由群里的手速决定。 */
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
      waiting.shift()?.();
    }
  };
}

/**
 * 建立禁漫下载服务。
 *
 * @param options - 运行时配置。
 * @param options.cwd - Agent 工作目录（沙箱根）：下载目录必须在它里面。
 * @param options.dir - 下载目录，相对 `cwd`。
 * @param options.python - python 解释器：绝对路径，或相对 `cwd` 的路径。
 * @param options.script - jm_download.py 的绝对路径。
 * @param options.enabled - 关掉后 `run()` 一律直接失败，不 spawn 任何东西。
 * @param options.maxChapters - 整本下载的话数上限（0 = 不限制）。
 * @param options.maxPages - 总页数上限（0 = 不限制）。
 * @param options.timeoutMs - 单次下载的硬超时。
 * @param options.requestTimeoutMs - jmcomic 单次 HTTP 请求超时（秒，传给 python）。
 * @param options.maxFiles - 目录里最多保留几个 PDF（LRU）。
 * @param options.maxJobs - 全局同时进行的下载数。
 * @param options.fileHost - NapCat 能访问到本机的地址（留空 = 按平台自动，见 util.js 的 defaultJmFileHost）。
 * @param options.filePort - HTTP 文件服务端口；0 = 由系统分配。
 * @param options.urlTtlMs - 交给 NapCat 的下载 URL 有效期。
 * @param options.spawn - 子进程实现（测试可注入）。
 * @param options.report - 日志回调 `(level, message)`。
 * @returns `{ enabled, directory, python, script, run, serve, prune, close }`。
 */
export function createJmService({
  cwd,
  dir = DEFAULT_DIR,
  python = DEFAULT_PYTHON,
  script,
  enabled = true,
  maxChapters = 0,
  maxPages = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestTimeoutMs = 30000,
  maxFiles = DEFAULT_MAX_FILES,
  maxJobs = 1,
  fileHost = defaultJmFileHost(),
  filePort = 0,
  urlTtlMs = DEFAULT_URL_TTL_MS,
  spawn = spawnProcess,
  report = () => {},
} = {}) {
  const root = resolve(cwd ?? process.cwd());
  const directory = resolve(root, dir.length > 0 ? dir : DEFAULT_DIR);
  // 和 mediaDir 同一条规矩：目录必须在 cwd 里，否则 Agent / 沙箱读不到，配置写错了
  // 就整体停用 —— 不要偷偷把几个 G 的 PDF 写到工作区外面去。
  const insideRoot = directory === root || directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const active = enabled === true && insideRoot && script !== undefined && script.length > 0;
  if (enabled === true && !insideRoot) report('warn', `jmDir "${dir}" resolves outside cwd (${root}); jm download is disabled`);
  if (enabled === true && (script === undefined || script.length === 0)) report('warn', 'no jm script configured; jm download is disabled');
  const pythonPath = isAbsolute(python) ? python : resolve(root, python);
  const runLimited = createLimiter(maxJobs);
  const byteCap = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : DEFAULT_MAX_FILES;
  const hardTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const ttl = Number.isFinite(urlTtlMs) && urlTtlMs > 0 ? Math.floor(urlTtlMs) : DEFAULT_URL_TTL_MS;
  /** 正在跑的会话 key：同一个会话同时只允许一个下载。 */
  const running = new Map();
  /** 活着的下载子进程：插件卸载时要一起收掉，别留孤儿。 */
  const children = new Set();
  /** 一次性下载 token → `{ path, name, expiresAt }`（交给 NapCat 的 URL）。 */
  const tickets = new Map();
  let server = null;
  let serverPort = 0;
  let serverHost = fileHost;
  let disposed = false;

  /**
   * 起（或复用）那个只给 NapCat 用的文件服务。
   * 绑不上配置的地址（没有 docker 网桥、host 写错）就退回 127.0.0.1 并告警：
   * 至少失败原因会出现在 journal 里，而不是一个「莫名其妙上传失败」。
   */
  async function ensureServer() {
    if (server !== null) return server;
    if (disposed) throw new Error('jm service is closed');
    const handler = (request, response) => {
      const match = /^\/f\/([0-9a-f]{16,})\/(.*)$/i.exec(request.url ?? '');
      if (request.method !== 'GET' || match === null) {
        response.writeHead(404).end('not found');
        return;
      }
      const ticket = tickets.get(match[1]);
      if (ticket === undefined || ticket.expiresAt < Date.now()) {
        tickets.delete(match[1]);
        response.writeHead(404).end('expired');
        return;
      }
      // 文件可能已经被 LRU 清掉：明确回 410，而不是一个空 200。
      stat(ticket.path).then(
        (info) => {
          response.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': String(info.size),
          });
          createReadStream(ticket.path).pipe(response);
        },
        () => response.writeHead(410).end('gone'),
      );
    };
    const attempt = (host) =>
      new Promise((resolvePort, rejectPort) => {
        const candidate = createServer(handler);
        candidate.once('error', rejectPort);
        candidate.listen(filePort, host, () => {
          candidate.removeListener('error', rejectPort);
          resolvePort(candidate);
        });
      });
    try {
      server = await attempt(fileHost);
      serverHost = fileHost;
    } catch (error) {
      report('warn', `jm: cannot listen on ${fileHost}:${filePort} (${reasonOf(error)}); falling back to 127.0.0.1 — NapCat in a container will NOT be able to fetch the file`);
      server = await attempt('127.0.0.1');
      serverHost = '127.0.0.1';
    }
    server.unref?.();
    serverPort = server.address().port;
    report('info', `jm: file server listening on ${serverHost}:${serverPort}`);
    return server;
  }

  /**
   * 把一个 PDF 登记成一次性 URL —— NapCat 从这个地址把文件拉走。
   * @param pdfPath - 绝对路径（校验过在下载目录内）。
   * @param name - 对外的文件名（给 QQ 显示的那个）。
   * @returns 形如 `http://172.17.0.1:41234/f/<token>/<name>` 的 URL。
   */
  async function serve(pdfPath, name = basename(pdfPath)) {
    await ensureServer();
    const token = randomBytes(16).toString('hex');
    tickets.set(token, { path: pdfPath, name, expiresAt: Date.now() + ttl });
    // token 是一次性的、还会过期，但也不能无限增长：超过 64 个就把最老的丢掉。
    if (tickets.size > 64) {
      const oldest = [...tickets.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (oldest !== undefined) tickets.delete(oldest[0]);
    }
    return `http://${serverHost}:${serverPort}/f/${token}/${encodeURIComponent(name)}`;
  }

  /** 按最近使用时间淘汰旧 PDF，把目录里的 `.pdf` 压回上限内。 */
  async function prune() {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
      const full = join(directory, entry.name);
      const info = await stat(full).catch(() => undefined);
      if (info !== undefined) files.push({ full, mtimeMs: info.mtimeMs });
    }
    if (files.length <= byteCap) return;
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const stale of files.slice(0, files.length - byteCap)) {
      await unlink(stale.full).catch(() => {});
      report('info', `jm: evicted ${basename(stale.full)}`);
    }
  }

  /** 把 jmcomic 的 stderr 一行行转进插件日志（剥色、去空行）。 */
  function forwardStderr(chunk, tail) {
    for (const line of String(chunk).split('\n')) {
      const text = line.replace(ANSI, '').trim();
      if (text.length === 0) continue;
      tail.push(text);
      if (tail.length > 12) tail.shift();
      // 逐张图的进度日志量很大（每张两行），但仍然比「下到哪了谁也不知道」强。
      report('info', `jm: ${text}`);
    }
  }

  /**
   * 跑一次下载：`python jm_download.py …`，读 stdout 上的 JSON Lines。
   *
   * @param options - 本次下载的参数。
   * @param options.id - 禁漫车号（纯数字）。
   * @param options.kind - `auto` / `album` / `chapter`。
   * @param options.key - 并发键（QQ 会话 key）；同一个 key 同时只允许一个任务。
   * @param options.onMeta - 拿到本子元信息（标题 / 话数 / 页数）时回调，用于先回一句进度。
   * @returns 成功时 `{ path, name, pages, bytes, title, kind, chapters, meta }`；失败抛错（永不挂死）。
   */
  async function run({ id, kind = 'auto', key = 'default', onMeta } = {}) {
    if (!active) throw new Error('jm download is disabled (check jmDownload / jmDir / jmPython / jmScript)');
    const jmId = String(id ?? '').trim();
    if (!/^\d{3,}$/.test(jmId)) throw new Error(`invalid jm id: ${id}`);
    if (running.has(key)) {
      const busy = new Error('already downloading for this conversation');
      busy.code = 'JM_BUSY';
      throw busy;
    }
    running.set(key, { startedAt: Date.now(), id: jmId });
    try {
      return await runLimited(() => spawnDownload({ id: jmId, kind, key, onMeta }));
    } finally {
      running.delete(key);
    }
  }

  /** `run()` 的实际动作（已被并发键与全局信号量保护）。 */
  async function spawnDownload({ id, kind, key, onMeta }) {
    const work = join(directory, `.work-${randomBytes(6).toString('hex')}`);
    await mkdir(directory, { recursive: true });
    const args = [
      script,
      '--id', id,
      '--kind', kind,
      '--work', work,
      '--out', directory,
      '--max-chapters', String(Math.max(0, Math.floor(Number(maxChapters) || 0))),
      '--max-pages', String(Math.max(0, Math.floor(Number(maxPages) || 0))),
      '--timeout', String(Math.max(1, Math.round((Number(requestTimeoutMs) || 30000) / 1000))),
    ];
    // 环境变量里把代理全部摘掉：这台机器上禁漫是直连的，校园网/公司网的代理设置
    // 一旦被 curl_cffi 捡走，轻则超时重则触发风控。jmcomic 的 option 里也已经
    // 显式写了 `proxies: None`，这里是第二道保险。
    const env = { ...process.env };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
      delete env[name];
    }
    const startedAt = Date.now();
    report('info', `jm: downloading ${id} (${kind}) → ${directory}`);
    const outcome = await new Promise((settle, fail) => {
      let child;
      try {
        child = spawn(pythonPath, args, {
          cwd: root,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !IS_WINDOWS,
          ...(IS_WINDOWS ? { windowsHide: true } : {}),
        });
      } catch (error) {
        fail(new Error(`cannot start ${pythonPath}: ${reasonOf(error)}`));
        return;
      }
      const tail = [];
      let stdout = '';
      let meta;
      let result;
      let finished = false;
      /**
       * 超时 / 出错时收掉这棵树。判定与两个平台的分支都在模块级的
       * {@link killProcessTree} 里 —— 插件卸载时的 `close()` 用的是同一个函数，
       * 免得两处各写一遍、其中一处忘了 Windows 没有进程组信号。
       */
      const killTree = () => killProcessTree(child);
      children.add(child);
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        killTree();
        fail(new Error(`timed out after ${Math.round(hardTimeout / 1000)}s`));
      }, hardTimeout);
      timer.unref?.();
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        children.delete(child);
        fn(value);
      };
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        // 协议是 JSON Lines：一行一个事件，最后一行可能还没收全，留在缓冲里。
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trim();
          if (text.length === 0) continue;
          let event;
          try {
            event = JSON.parse(text);
          } catch {
            report('warn', `jm: unparsable output line: ${text.slice(0, 200)}`);
            continue;
          }
          if (event.event === 'meta') {
            meta = event;
            report('info', `jm: ${event.title || id} — ${event.chapters} chapter(s), ${event.pages} page(s)`);
            try {
              onMeta?.(event);
            } catch (error) {
              report('warn', `jm: onMeta failed: ${reasonOf(error)}`);
            }
            continue;
          }
          if (event.event === 'result') {
            result = event;
            continue;
          }
          report('warn', `jm: unknown output event: ${text.slice(0, 200)}`);
        }
      });
      child.stderr?.on('data', (chunk) => forwardStderr(chunk, tail));
      child.once('error', (error) => {
        finish(fail, new Error(`${pythonPath}: ${reasonOf(error)}`));
      });
      child.once('close', (code) => {
        if (result === undefined) {
          const detail = tail.length > 0 ? `: ${tail.slice(-4).join(' | ')}` : '';
          finish(fail, new Error(`jm_download.py exited with code ${code}${detail}`));
          return;
        }
        if (result.ok !== true) {
          finish(fail, new Error(String(result.error ?? 'jm download failed')));
          return;
        }
        finish(settle, { result, meta });
      });
    });

    const { result, meta } = outcome;
    // 结果路径来自子进程（python 侧已清洗过文件名），仍然按「不可信」处理：
    // 必须在下载目录里，否则拒绝把任意文件当作 PDF 发出去。
    const pdfPath = resolve(String(result.pdf));
    const inside = pdfPath === directory || pdfPath.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
    if (!inside) throw new Error(`jm_download.py returned a path outside the download dir: ${result.pdf}`);
    const info = await stat(pdfPath).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size === 0) {
      throw new Error(`jm_download.py reported ${result.pdf} but no such file`);
    }
    await prune();
    const name = safeFileName(basename(pdfPath, '.pdf'), `jm${id}`);
    report('info', `jm: ${id} done — ${name}.pdf (${info.size} bytes, ${result.pages ?? '?'} page(s)) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return {
      path: pdfPath,
      name: `${name}.pdf`,
      pages: Number(result.pages ?? 0),
      bytes: info.size,
      title: String(result.title ?? meta?.title ?? ''),
      kind: String(result.kind ?? kind),
      chapters: Number(result.chapters ?? meta?.chapters ?? 1),
      meta: meta ?? {},
      workDir: work,
    };
  }

  /** 关掉文件服务（插件卸载时调用），并把还在下载的子进程一并收掉。 */
  function close() {
    disposed = true;
    tickets.clear();
    for (const child of children) killProcessTree(child);
    children.clear();
    const current = server;
    server = null;
    current?.close();
  }

  /** 某个 key（QQ 会话）是否正在下载 —— 用来决定要不要回一句「还在下」。 */
  function isRunning(key) {
    return running.has(key);
  }

  return { enabled: active, directory, python: pythonPath, script, run, serve, prune, close, isRunning };
}
