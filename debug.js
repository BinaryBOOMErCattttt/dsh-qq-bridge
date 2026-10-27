/**
 * 调试提权（`debug` / `overdebug`）：主人私聊里临时把工作区外的读写与命令执行打开 10 分钟。
 *
 * 为什么要单独一个模块：这是整个插件里**唯一**能绕过 `cwd` 沙箱的通道，所以它的状态机
 * （开关 / 会话 / 过期 / 审计 / 回滚）必须一眼能读完、能单测。散在 `index.js` 的闭包里时，
 * 「哪一刻失效」「回滚到底恢复了什么」只能靠翻六千行去拼。
 *
 * 五条纪律，改这个文件前先看：
 *
 *   1. **四道闸全开才放行**：配置 `debug` 开着 + 模块 `moduleDebug` 没关 + 自己没过期 +
 *      **就是开启它的那个私聊会话** + 这一轮说话的人在主人名单里。少一道都是提权事故。
 *   2. **默认关**：`debug: false` 时连 `debug` 指令都只回一句「没开」。这不是「配了就能用」，
 *      而是「配了、还得主人在私聊里现开一次、还得在 10 分钟内」。
 *   3. **先备份再动手**：开启时把配置与几份关键文件复制到 `data/debug/<时间>/baseline/`；
 *      `qq_debug_write` 覆盖任何文件前先按路径备份一次（同一次 debug 里只备份第一次），
 *      清单落在 `manifest.json` —— `debug rollback` 就是照着它倒着恢复。
 *   4. **一切留痕**：每个工具调用写 `data/debug-audit.log`，同时写进本次的 `CHANGELOG.md`；
 *      模型每改完一轮用 `qq_debug_log` 记「改了什么 / 文件:行号」，这样下一个 agent（或者
 *      三天后的自己）读一份文件就知道发生过什么。
 *   5. **shell 不可回滚**：命令能做的事太多了，审计只能证明「跑过什么」，恢复不了副作用。
 *      所以回复与文档里都明说「要可回滚的改动请用 qq_debug_write」。
 *
 * 依赖全部由 `index.js` 显式传入（`cwd` / 会话反查 / 权限 / 发送 / 重启），本模块不 import
 * `index.js`，也不自己读配置对象。
 *
 * @module @qqbot/dsh-plugin-qq/debug
 */
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { errorText } from './util.js';

/** 提权时长：10 分钟。够改一处、看一轮日志，又不至于忘在那儿。 */
export const DEBUG_TTL_MS = 10 * 60 * 1000;

/** 审计里单个字段的正文上限（命令可能带一整段脚本，别把日志撑爆）。 */
const AUDIT_DETAIL_MAX = 2000;

/**
 * baseline 里复制的那几份文件：`name` 是备份目录里的文件名，`root` 决定解析根
 * （`cwd` = 工作目录，`plugin` = 插件根 —— `cordis.patch.yml` 在插件根里）。
 */
const BASELINE_FILES = [
  { name: 'owner-settings.json', root: 'cwd', segs: ['data', 'owner-settings.json'] },
  { name: 'mutes.json', root: 'cwd', segs: ['data', 'mutes.json'] },
  { name: 'PERSONA.md', root: 'cwd', segs: ['.qq-persona', 'PERSONA.md'] },
  { name: 'STYLE.md', root: 'cwd', segs: ['.qq-persona', 'STYLE.md'] },
  { name: 'cordis.patch.yml', root: 'plugin', segs: ['cordis.patch.yml'] },
];

/** 设置快照里**不能**落盘的字段：它们是凭据，调试日志不该顺手泄露。 */
const SECRET_KEYS = ['accessToken', 'apiKey', 'apiKeyRef'];

/** 目录名用的时间戳（`:` / `.` 在 Windows 上是非法字符）。 */
export function debugStamp(at = Date.now()) {
  return new Date(at).toISOString().replace(/[:.]/gu, '-');
}

/**
 * 建一个调试提权状态机。
 *
 * @param deps - 依赖表：
 *   - `cwd`：工作目录（审计 / 备份都写在它下面的 `data/`）；
 *   - `pluginRoot`：插件根（备份 `cordis.patch.yml` 用）；
 *   - `settings`：最终生效的配置（只读 `debug`）；
 *   - `report(level, message)`：日志；
 *   - `moduleEnabled(name)`：`moduleDebug` 关掉时整条提权不可用；
 *   - `conversationOfExec(exec)`：工具调用来自哪个会话；
 *   - `writeAuthority(exec)`：这一轮说话的人有没有主人权限；
 *   - `send(conversation, text)`：给会话发一句说明（不等待）；
 *   - `restart()`：设置文件恢复之后重启插件；
 *   - `now()` / `setTimeout` / `clearTimeout`：测试注入用（默认全局）。
 * @returns 见文件末尾的返回对象。
 */
export function createDebugMode({
  cwd,
  pluginRoot,
  settings,
  report = () => {},
  moduleEnabled = () => true,
  conversationOfExec = () => undefined,
  writeAuthority = () => ({ allowed: false, reason: 'no authority' }),
  send = () => {},
  restart = () => {},
  now = () => Date.now(),
  setTimeout: setTimeoutOf = setTimeout,
  clearTimeout: clearTimeoutOf = clearTimeout,
}) {
  /** 提权状态。**只对开启它的那个私聊会话 + 那一段 TTL** 有效。 */
  const state = {
    active: false,
    key: '',
    conversation: undefined,
    until: 0,
    timer: undefined,
    dir: '',
    logFile: '',
  };

  /** 配置与模块两层开关（与 `debugGuard` 分开，便于给回复写出具体原因）。 */
  function configured() {
    if (settings.debug !== true) return { ok: false, reason: 'debug 配置没开（设置 debug true）' };
    if (!moduleEnabled('debug')) return { ok: false, reason: 'debug 模块关着（或简洁模式）；要开就在设置里把 moduleDebug 设成 true' };
    return { ok: true };
  }

  /** 这个会话现在是否处在有效的提权窗口里（提示词与工具守卫共用同一判据）。 */
  function activeFor(conversation) {
    return state.active === true
      && conversation !== undefined
      && state.key === conversation.key
      && now() < state.until;
  }

  /**
   * 工具守卫：四道闸 + 主人当轮。
   * @param exec - 工具执行上下文。
   * @returns `{ allowed, reason? }`（拒绝原因直接回给模型，它会照实说出来）。
   */
  function guard(exec) {
    const gate = configured();
    if (!gate.ok) return { allowed: false, reason: gate.reason };
    if (state.active !== true) return { allowed: false, reason: 'debug 模式没开（主人在私聊里发 debug）' };
    if (now() >= state.until) return { allowed: false, reason: 'debug 模式已过期，重新发 debug' };
    const conversation = conversationOfExec(exec);
    if (conversation === undefined || conversation.key !== state.key) {
      return { allowed: false, reason: 'debug 只对开启它的那个私聊会话生效' };
    }
    const authority = writeAuthority(exec);
    if (authority.allowed !== true) return { allowed: false, reason: authority.reason };
    return { allowed: true };
  }

  /** 写一行审计：全局 `data/debug-audit.log` + 本次的 `CHANGELOG.md`（没有就只写前者）。 */
  async function audit(event, detail, target = state.logFile) {
    try {
      await mkdir(join(cwd, 'data'), { recursive: true });
      const stamp = new Date(now()).toISOString();
      const text = JSON.stringify(detail ?? {}).slice(0, AUDIT_DETAIL_MAX);
      await appendFile(join(cwd, 'data', 'debug-audit.log'), `${stamp} ${event} ${text}\n`, 'utf8');
      if (typeof target === 'string' && target.length > 0) {
        await appendFile(target, `- ${stamp} \`${event}\` ${text}\n`, 'utf8');
      }
    } catch (error) {
      report('warn', `debug audit failed: ${errorText(error)}`);
    }
  }

  /** baseline 里那一项在磁盘上的真实路径（`cwd` 或插件根）。 */
  function baselineTarget(entry) {
    return entry.root === 'plugin' ? join(pluginRoot, ...entry.segs) : join(cwd, ...entry.segs);
  }

  /**
   * 开启时快照：设置（去掉凭据）+ 那几份关键文件。
   * @returns `{ dir, logFile, copied }`。
   */
  async function snapshot() {
    const dir = join(cwd, 'data', 'debug', debugStamp(now()));
    const baseline = join(dir, 'baseline');
    await mkdir(baseline, { recursive: true });
    const copied = [];
    for (const entry of BASELINE_FILES) {
      const source = baselineTarget(entry);
      const info = await stat(source).catch(() => undefined);
      if (info?.isFile() !== true) continue;
      await copyFile(source, join(baseline, entry.name));
      copied.push(entry.name);
    }
    const redacted = { ...settings };
    for (const key of SECRET_KEYS) delete redacted[key];
    await writeFile(join(baseline, 'settings.json'), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    const logFile = join(dir, 'CHANGELOG.md');
    await writeFile(
      logFile,
      [
        '# Debug 变更日志',
        '',
        `- 开始：${new Date(now()).toLocaleString('zh-CN', { hour12: false })}`,
        `- 会话：${state.key}`,
        '- 时长：最多 10 分钟（或 `overdebug`）',
        `- 基线目录：\`${relative(cwd, dir)}\``,
        `- 已备份：${copied.join('、') || '（没有可备份的文件）'}`,
        '',
        '## 基线说明',
        '',
        '`baseline/` 下是开启 debug 时的设置快照；`settings.json` 已去掉 accessToken / apiKey / apiKeyRef。',
        '`qq_debug_write` 改动的文件会自动备份到 `backup/`，`debug rollback` 按 `manifest.json` 恢复。',
        '`qq_debug_shell` 执行的命令只能审计，无法自动回滚 —— 需要可回滚的改动请用 qq_debug_write。',
        '',
        '## 活动记录',
        '',
      ].join('\n'),
      'utf8',
    );
    return { dir, logFile, copied };
  }

  async function readManifest() {
    try {
      const parsed = JSON.parse(await readFile(join(state.dir, 'manifest.json'), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * `qq_debug_write` 覆盖前备份原文件；同一次 debug 里同一个路径只备份第一次。
   *
   * 为什么按**路径**去重而不是按内容：回滚要恢复的是「这个文件在 debug 之前的样子」，
   * 第二次覆盖时再备份一份就变成了「第一次改完的样子」。只留最原始的那份才对。
   * @param path - 即将被写的绝对路径。
   */
  async function backup(path) {
    if (state.active !== true || state.dir.length === 0) return;
    if (path.startsWith(state.dir)) return;
    const manifest = await readManifest();
    if (manifest.some((entry) => entry?.path === path)) return;
    const info = await stat(path).catch(() => undefined);
    const entry = { path, existed: info?.isFile() === true };
    if (entry.existed) {
      await mkdir(join(state.dir, 'backup'), { recursive: true });
      const name = join('backup', `${manifest.length}-${basename(path)}`);
      await copyFile(path, join(state.dir, name));
      entry.backup = name;
    }
    manifest.push(entry);
    await writeFile(join(state.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  /** 模型手动记一轮改动（摘要 / 代码位置），追加进本次的 CHANGELOG.md。 */
  async function log(summary, files, notes) {
    if (state.logFile.length === 0) return false;
    const text = String(notes ?? '').trim();
    const lines = [
      '',
      `### ${new Date(now()).toLocaleString('zh-CN', { hour12: false })}`,
      '',
      String(summary ?? '').trim() || '（没有摘要）',
      '',
      `- 代码位置：${String(files ?? '').trim() || '（未填）'}`,
      ...(text.length > 0 ? [`- 备注：${text}`] : []),
      '',
    ];
    await appendFile(state.logFile, lines.join('\n'), 'utf8');
    return true;
  }

  /**
   * 回滚：按 manifest 倒着恢复被写过的文件，再把 baseline 里的几份配置拷回去。
   *
   * 顺序是刻意的：先恢复「这一次 debug 里被改的文件」，再恢复基线 —— 两者可能指向同一个
   * 路径（比如直接改了 `cordis.patch.yml`），基线更新，应该以它为准。
   */
  async function rollback() {
    if (state.active !== true) {
      send(state.conversation, '现在不在 debug 模式。');
      return false;
    }
    const dir = state.dir;
    const conversation = state.conversation;
    let restored = 0;
    try {
      for (const entry of (await readManifest()).reverse()) {
        if (typeof entry?.path !== 'string' || entry.path.length === 0) continue;
        if (entry.existed === true && typeof entry.backup === 'string') {
          await copyFile(join(dir, entry.backup), entry.path);
          restored += 1;
        } else if (entry.existed === false) {
          await unlink(entry.path).catch(() => {});
          restored += 1;
        }
      }
      for (const entry of BASELINE_FILES) {
        const source = join(dir, 'baseline', entry.name);
        const info = await stat(source).catch(() => undefined);
        if (info?.isFile() !== true) continue;
        const target = baselineTarget(entry);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        restored += 1;
      }
      await audit('debug_rollback', { restored });
      stop('rollback');
      send(
        conversation,
        `已回滚 debug 期间可追踪的改动（${restored} 项）。shell 命令造成的改动无法自动回滚，请看 \`${relative(cwd, join(dir, 'CHANGELOG.md'))}\`。`,
      );
      // 配置 / 覆盖层可能被恢复了：让插件重启一次，把新的文件真正读回来。
      restart();
      return true;
    } catch (error) {
      await audit('debug_rollback_failed', { error: errorText(error) });
      send(conversation, `回滚失败：${errorText(error)}；debug 仍开着，可用 overdebug 先退出。`);
      return false;
    }
  }

  /**
   * 开启：只认主人私聊；先快照，再挂 10 分钟 TTL。
   * @param conversation - 发起 `debug` 指令的会话。
   */
  async function start(conversation) {
    const gate = configured();
    if (!gate.ok) {
      // 原因由 configured() 给（配置没开 / 模块关着），照实转述 —— 少一句「为什么」，
      // 主人只能去翻文档才发现自己关的是哪一层。
      send(conversation, `debug 没开：${gate.reason}。`);
      return;
    }
    if (conversation.type !== 'private') {
      send(conversation, 'debug 只能在主人私聊里开。');
      return;
    }
    if (state.active === true && now() < state.until) {
      const left = Math.ceil((state.until - now()) / 60_000);
      send(conversation, `debug 已经开着，还剩约 ${left} 分钟；要退出就发 overdebug，要回滚发 debug rollback。`);
      return;
    }
    if (state.timer !== undefined) clearTimeoutOf(state.timer);
    state.key = conversation.key;
    state.conversation = conversation;
    state.until = now() + DEBUG_TTL_MS;
    try {
      const snap = await snapshot();
      state.dir = snap.dir;
      state.logFile = snap.logFile;
      state.active = true;
    } catch (error) {
      state.active = false;
      state.key = '';
      state.conversation = undefined;
      state.until = 0;
      report('warn', `debug snapshot failed: ${errorText(error)}`);
      send(conversation, `debug 没开成：设置备份失败（${errorText(error)}）。`);
      return;
    }
    state.timer = setTimeoutOf(() => stop('timeout'), DEBUG_TTL_MS);
    state.timer?.unref?.();
    void audit('debug_on', {
      key: conversation.key,
      dir: relative(cwd, state.dir),
      until: new Date(state.until).toISOString(),
    });
    send(
      conversation,
      [
        '调试模式已开：接下来 10 分钟，我可以读写工作区外的文件、执行命令。',
        `设置已备份到：\`${relative(cwd, state.dir)}/baseline/\``,
        `变更日志：\`${relative(cwd, state.logFile)}\`（每次改动用 qq_debug_log 记下代码位置）。`,
        '发 `overdebug` 退出（保留改动），发 `debug rollback` 回滚可追踪的改动并退出。',
      ].join('\n'),
    );
  }

  /**
   * 退出：清状态、停定时器、写审计。工具随即恢复拒绝（守卫先看 `active`）。
   * @param reason - `timeout` / `manual` / `rollback`。
   * @returns 之前是否真的开着。
   */
  function stop(reason) {
    if (state.active !== true) return false;
    const conversation = state.conversation;
    const logFile = state.logFile;
    if (state.timer !== undefined) clearTimeoutOf(state.timer);
    state.active = false;
    state.key = '';
    state.conversation = undefined;
    state.until = 0;
    state.timer = undefined;
    void audit('debug_off', { reason, dir: state.dir.length > 0 ? relative(cwd, state.dir) : '' }, logFile);
    if (conversation !== undefined) {
      send(
        conversation,
        `调试模式已退出（${reason === 'timeout' ? '到点自动退出' : reason === 'rollback' ? '回滚完成' : '主人手动退出'}），能力和提示词都恢复正常。变更日志还在 \`${logFile.length > 0 ? relative(cwd, logFile) : 'data/debug/'}\`。`,
      );
    }
    state.logFile = '';
    state.dir = '';
    return true;
  }


  /** `execFile` 的 promise 版：`qq_debug_shell` 不经过 shell，参数不会被二次解释。 */
  const execFileAsync = promisify(execFile);

  /** shell 输出上限：32 KB 足够看清报错，又不至于把一整个构建日志塞进上下文。 */
  const SHELL_OUTPUT_MAX = 32_768;

  /**
   * 在指定目录跑一条命令（`qq_debug_shell` 的实现在这里，不在 tools.js）。
   *
   * 为什么把这条最危险的动作留在这个模块里：它和「谁能调、什么时候失效、审计写到哪」
   * 是同一件事；散到工具声明里就变成「工具权限靠 tools.js，状态机靠 debug.js」两处对不上。
   * Windows 用 `powershell.exe -NoProfile -Command`，其它平台用 `/bin/bash -lc`；统一加超时
   * 与输出截断 —— 一条 `tail -f` 就能把整个进程挂死。
   * @param command - 命令行原文。
   * @param cwdOf - 工作目录（默认 `cwd`）。
   * @param timeoutMs - 超时（默认 30 秒，上限 120 秒）。
   * @returns `{ stdout, stderr, code }`。
   */
  async function runShell(command, cwdOf, timeoutMs) {
    const line = String(command ?? '').trim();
    if (line.length === 0) throw new Error('命令不能为空');
    const workdir = cwdOf === undefined ? cwd : cwdOf;
    const timeout = Math.max(1000, Math.min(120_000, Math.floor(Number(timeoutMs ?? 30_000) || 30_000)));
    const windows = process.platform === 'win32';
    const argv = windows ? ['-NoProfile', '-Command', line] : ['-lc', line];
    try {
      const { stdout, stderr } = await execFileAsync(windows ? 'powershell.exe' : '/bin/bash', argv, {
        cwd: workdir,
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      await audit('qq_debug_shell', { command: line, cwd: workdir, code: 0 });
      return { stdout: String(stdout).slice(0, SHELL_OUTPUT_MAX), stderr: String(stderr).slice(0, SHELL_OUTPUT_MAX), code: 0 };
    } catch (error) {
      // 命令失败（非零退出 / 超时）也是审计的一部分：模型看着报错改下一版，而回滚只能靠
      // 它自己记。抛出去让工具层把 stderr 交给模型。
      await audit('qq_debug_shell', {
        command: line,
        cwd: workdir,
        code: Number(error?.code ?? 1),
        error: String(error?.message ?? error),
      });
      throw error;
    }
  }

  return {
    /** 只读状态（测试 / 状态指令用）。 */
    state,
    configured,
    activeFor,
    guard,
    audit,
    snapshot,
    backup,
    log,
    rollback,
    start,
    stop,
    runShell,
  };
}
