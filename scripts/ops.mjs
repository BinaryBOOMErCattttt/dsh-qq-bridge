#!/usr/bin/env node
/**
 * 运维执行器 + CLI：**收集事实 → 让 `ops.js` 算计划 → 打印 / 执行 → 按 §10.3 的退出码收场**。
 *
 * 为什么要有这一层（而不是把判断写进脚本）：同一份计划在 Linux / Windows / 容器上是三套
 * 命令，但「什么算正常、什么算坏了」是同一套判据。判据留在 `ops.js`（纯、可测），
 * 这个文件只做三件不纯的事：读文件、起子进程、按平台渲染人话。
 *
 * 用法（在仓库根目录）：
 *
 *     node scripts/ops.mjs doctor [--json] [--fix]
 *     node scripts/ops.mjs status [--json]
 *     node scripts/ops.mjs restart [--json]
 *     node scripts/ops.mjs logs [-n 100] [--json]
 *     node scripts/ops.mjs install [--qq <号>] [--apply] [--json]
 *     node scripts/ops.mjs uninstall [--apply]
 *     node scripts/ops.mjs napcat config|start|autologin|webui [--apply]
 *     node scripts/ops.mjs migrate cognition [--apply] [--json]
 *     node scripts/ops.mjs cleanup jm [--apply] [--json]
 *     node scripts/ops.mjs selftest [--json]
 *
 * 三条硬规矩：
 *
 *   1. **`--apply` 默认关**，而且分两种含义（都是「默认不写」）：
 *      `install` / `uninstall` 的 `--apply` 只执行 `requires: 'workspace'` 的步骤 ——
 *      写 systemd unit、注册计划任务、改 profile 一律拒绝并给退出码 2；
 *      `napcat` / `cleanup` / `migrate` 的 `--apply` 是「我授权动 cwd 外 / 删数据」——
 *      这些子命令本身没有第二个执行者，不给 `--apply` 就只打印计划。两类都**永不**代跑
 *      `requires: 'root'` 的步骤（提权命令只能人自己来）。
 *   2. **子进程只用 argv 数组 + `shell: false`**，并且都有超时。`command` 字段是给人复制
 *      的字符串，绝不回喂给 shell：路径里一个空格、配置里一个 `&&` 就能让命令跑到别处。
 *   3. **`--json` 时 stdout 里只有一个 JSON 对象**：所有给人看的话（包括子进程输出）
 *      都走 stderr。agent 解析 stdout，人看 stderr，两边互不污染。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/ops
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONTAINER,
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_LINES,
  DEFAULT_UNIT,
  OPS_COMMANDS,
  OPS_SCHEMA,
  detectPlatform,
  doctorFindings,
  doctorSteps,
  exitCodeFor,
  installPlan,
  renderPlan,
  servicePlan,
} from '../ops.js';
import { cognitionPathViolations, duplicateSectionNames, parseCognition, parseStickerCatalog } from '../cognition.js';
import {
  HIDDEN_WRAPPER_NAME,
  TASK_NAME,
  accountFiles,
  endpointTarget,
  findNapcatDir,
  hiddenStartPlan,
  inspectNapcat,
  repairNapcat,
  scheduledTaskQueryPlan,
  startPlan,
  webuiTarget,
  withAutoLoginAccount,
} from '../napcat.js';
import { PLUGIN_NAME, applyEnvBlock, pluginLinkState, withPluginInstalled } from '../desktop.js';
import { readTextOrUndefined, writeJsonAtomic } from '../filestore.js';
import { errorText, parseApiKeyPool } from '../util.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 一条 `--key value` / `-n 100` / `--flag` 的命令行。
 *
 * 值型开关单独列名单：`--container` 既可以是开关（用默认容器名）也可以带值（容器名），
 * 两种写法都得认，所以「后面那个是不是另一个开关」要在这里判一次。
 */
function parseArgs(argv) {
  const valueFlags = new Set(['n', 'qq', 'unit', 'unit-path', 'task-name', 'profile', 'container', 'endpoint', 'token', 'napcat', 'port', 'log-file', 'dsh-home', 'cwd', 'window']);
  const positionals = [];
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!/^-{1,2}[A-Za-z][\w-]*$/.test(item)) {
      positionals.push(item);
      continue;
    }
    const name = item.replace(/^--?/, '');
    if (!valueFlags.has(name)) {
      flags.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || /^-{1,2}[A-Za-z][\w-]*$/.test(next)) {
      flags.add(name);
      continue;
    }
    values[name] = next;
    index += 1;
  }
  return { positionals, flags, values };
}

const args = parseArgs(process.argv.slice(2));
const jsonMode = args.flags.has('json');
const applyMode = args.flags.has('apply');
const cwd = resolve(String(args.values.cwd ?? process.cwd()));
const logLines = (() => {
  const raw = Number(args.values.n);
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 10000) : DEFAULT_LOG_LINES;
})();
const endpoint = String(args.values.endpoint ?? process.env.QQBOT_ENDPOINT ?? '').trim() || DEFAULT_ENDPOINT;
/** `--token` / 环境变量里的 access_token；**从不**从 `.env` 里读明文（AGENTS.md §10.2 的纪律）。 */
const explicitToken = String(args.values.token ?? process.env.QQBOT_ACCESS_TOKEN ?? '').trim();

// ---------------------------------------------------------------------------
// 输出：人话与 JSON 严格分流
// ---------------------------------------------------------------------------

/**
 * 人话出口。`--json` 时改走 stderr：stdout 只允许出现那一个 JSON 对象，
 * 否则 `JSON.parse(stdout)` 会当场炸掉，agent 拿到的就是一段带日志的乱码。
 */
function say(text) {
  const line = String(text ?? '');
  if (jsonMode) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** 给多行子进程输出加缩进：不加的话它和步骤标题混在一起，读的人分不清哪行是谁的。 */
function indent(text) {
  return String(text ?? '')
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .slice(0, 400)
    .map((line) => `      ${line}`)
    .join('\n');
}

const WHO_LABEL = {
  workspace: '脚本自己就能做',
  human: '需要人拍板（cwd 外的写 / 删数据）',
  root: '需要提权，脚本不代跑',
};

const STATUS_LABEL = {
  planned: '计划中',
  skipped: '已完成，跳过',
  done: '已完成',
  refused: '未执行',
  failed: '失败',
};

function whoLabel(requires) {
  return WHO_LABEL[requires] ?? requires;
}

function printFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    say('没有发现明显问题。');
    return;
  }
  const levelLabel = { error: '错误', warn: '警告', info: '提示' };
  say(`诊断结果（${findings.length} 条）：`);
  for (const item of findings) {
    say(`  [${levelLabel[item.level] ?? item.level}] ${item.code} —— ${item.message}`);
    if (String(item.fix ?? '').length > 0) say(`      怎么办：${item.fix}`);
    say(`      谁来修：${whoLabel(item.requires)}`);
  }
}

function printSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    say('没有要执行的步骤。');
    return;
  }
  say(`步骤（${steps.length} 条）：`);
  for (const item of steps) {
    const optional = item.optional === true ? '（可选）' : '';
    say(`  ${item.id}  [${whoLabel(item.requires)}]  ${STATUS_LABEL[item.status] ?? item.status}${optional}`);
    if (String(item.command ?? '').length > 0) say(`      命令：${item.command}`);
    if (String(item.note ?? '').length > 0) say(`      说明：${item.note}`);
  }
}

/** 按 §10.3 + 「执行失败也算没通过」收口：失败步骤不在纯函数里，所以在这里并进去。 */
function finalCode(payload) {
  const base = exitCodeFor(payload);
  if (base === 3 || base === 1) return base;
  return (payload.steps ?? []).some((item) => item.status === 'failed') ? 1 : base;
}

/** 打印（人话已经走 say 了）+ 需要时打一个 JSON 对象 + 返回退出码。 */
function conclude(action, platform, payload) {
  const code = finalCode(payload);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      schema: OPS_SCHEMA,
      ok: code === 0,
      action,
      platform,
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      steps: Array.isArray(payload.steps) ? payload.steps : [],
    }, null, 2)}\n`);
  }
  return code;
}

/** 脚本自身出错（退出码 3）：用法错误、迁移脚本缺失、模块契约不对。 */
function fail(action, platform, message) {
  say(`错误：${message}`);
  return conclude(action, platform, { error: message });
}

// ---------------------------------------------------------------------------
// 事实来源：路径与名字
// ---------------------------------------------------------------------------

function dshHome() {
  const explicit = String(args.values['dsh-home'] ?? process.env.DSH_HOME ?? '').trim();
  return explicit.length > 0 ? resolve(explicit) : join(homedir(), '.dsh');
}

function profileName() {
  return String(args.values.profile ?? process.env.QQBOT_PROFILE ?? '').trim() || 'qqbot';
}

function profileDir() {
  return join(dshHome(), 'profiles', profileName());
}

function unitName() {
  return String(args.values.unit ?? '').trim() || DEFAULT_UNIT;
}

function systemdUnitPath() {
  const explicit = String(args.values['unit-path'] ?? '').trim();
  if (explicit.length > 0) return resolve(explicit);
  return join(homedir(), '.config', 'systemd', 'user', `${unitName()}.service`);
}

function taskName() {
  return String(args.values['task-name'] ?? '').trim() || TASK_NAME;
}

function containerName() {
  return String(args.values.container ?? '').trim() || DEFAULT_CONTAINER;
}

function napcatLogFile() {
  return String(args.values['log-file'] ?? '').trim();
}

function qqNumber() {
  return String(args.values.qq ?? '').trim();
}

// ---------------------------------------------------------------------------
// 事实来源：子进程与文件
// ---------------------------------------------------------------------------

/**
 * 起一个子进程并收下输出（**永不**捕获失败就当成功）。
 *
 * `shell: false` 是硬要求：所有参数都是 argv 里的独立元素，不会被 shell 二次解释。
 * `timeout` 也是硬要求：`systemctl --user status` 在等 dbus 时能挂很久，而运维脚本
 * 必须「要么给结论，要么尽快说查不动」，不能把 agent 卡死。
 */
function runCapture(command, argsList, timeout = 5000) {
  try {
    const result = spawnSync(command, argsList, {
      encoding: 'utf8',
      timeout,
      shell: false,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error !== undefined && result.error !== null) {
      return {
        ok: false,
        status: null,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        error: String(result.error.code ?? result.error.message ?? result.error),
      };
    }
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: errorText(error), error: 'spawn' };
  }
}

/** 只给 `napcat start` 用：常驻进程不能等它退出，发了就返回。 */
function spawnDetached(command, argsList) {
  return new Promise((done) => {
    try {
      const child = spawn(command, argsList, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      child.once('error', (error) => done({ ok: false, message: errorText(error) }));
      child.once('spawn', () => {
        child.unref();
        done({ ok: true, message: '已发出启动' });
      });
    } catch (error) {
      done({ ok: false, message: errorText(error) });
    }
  });
}

/**
 * 探一次 OneBot 的 TCP 端口。
 *
 * 为什么是 TCP 而不是 WebSocket 握手：这里要回答的是「NapCat 那一边在不在听」，
 * 而握手还要 token、要建完整连接、失败时也说不清是端口不通还是鉴权被拒。
 * TCP 连不上就一定是端口/进程问题 —— 那正是 doctor 该先排除的那一层。
 */
function probeEndpoint(target, timeoutMs = 800) {
  const parsed = endpointTarget(target);
  if (parsed === undefined || parsed.port === undefined) return Promise.resolve(undefined);
  const host = parsed.host.startsWith('[') && parsed.host.endsWith(']') ? parsed.host.slice(1, -1) : parsed.host;
  return new Promise((done) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // 已经断了，无所谓。
      }
      done(value);
    };
    try {
      socket = connect({ host, port: parsed.port });
    } catch {
      done(false);
      return;
    }
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function hasSystemdSession() {
  if (process.platform !== 'linux') return false;
  // `--version` 在「装了 systemctl 但没有用户级 systemd」的机器上照样返回 0，
  // 所以探的是真正要用的那个：`--user show-environment`。
  return runCapture('systemctl', ['--user', 'show-environment'], 2500).ok;
}

function containerForced() {
  return args.flags.has('container')
    || args.values.container !== undefined
    || String(process.env.QQBOT_OPS_CONTAINER ?? '') === '1';
}

/** NapCat 是不是以容器方式跑着：`docker ps -a` 里有没有同名容器（一条命令）。 */
function napcatContainerExists() {
  if (process.platform !== 'linux') return false;
  const name = containerName();
  const result = runCapture('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'], 3000);
  if (!result.ok) return false;
  return result.stdout.split(/\r?\n/).some((line) => line.trim() === name);
}

function systemdIsActive() {
  const result = runCapture('systemctl', ['--user', 'is-active', unitName()], 3000);
  if (result.error !== undefined) return undefined;
  const word = result.stdout.trim().split(/\s+/)[0] ?? '';
  if (word === 'active' || word === 'reloading' || word === 'activating') return true;
  if (word === 'inactive' || word === 'failed' || word === 'deactivating') return false;
  return result.status === 0;
}

function systemdIsEnabled() {
  const result = runCapture('systemctl', ['--user', 'is-enabled', unitName()], 3000);
  if (result.error !== undefined) return undefined;
  const word = result.stdout.trim().split(/\s+/)[0] ?? '';
  if (word.startsWith('enabled')) return true;
  if (word === 'disabled' || word === 'masked' || word === 'masked-runtime' || word === 'not-found' || word === 'linked' || word === 'linked-runtime') return false;
  return result.status === 0 ? true : undefined;
}

function lingeringEnabled() {
  const user = String(process.env.USER ?? process.env.LOGNAME ?? '').trim();
  if (user.length === 0) return undefined;
  const result = runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value'], 3000);
  if (!result.ok) return undefined;
  const value = result.stdout.trim().toLowerCase();
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return undefined;
}

/**
 * journal 里最近有没有「一看就知道这个插件没激活/端口被占」的那种行。
 *
 * 只取一行命中（不是整段日志）：doctor 的回答要短，完整上下文交给 `ops.mjs logs`。
 * 关键词来自 AGENTS.md §10 的事故表（`cannot get property … without inject`、
 * `did not activate`）与最常见的端口冲突。
 */
function journalProblem() {
  const result = runCapture('journalctl', ['--user', '-u', unitName(), '-n', '80', '--no-pager'], 4000);
  if (!result.ok) return undefined;
  const pattern = /cannot get property .* without inject|did not activate|EADDRINUSE|ECONNREFUSED|spawn EPERM/i;
  const hit = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && pattern.test(line));
  return hit;
}

function isWritable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 目录里最新那个文件（Windows 上 NapCat 的日志文件名带时间戳，靠 mtime 找最稳）。 */
function newestFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best;
  for (const name of names) {
    const full = join(dir, name);
    try {
      const info = statSync(full);
      if (!info.isFile()) continue;
      if (best === undefined || info.mtimeMs > best.mtimeMs) best = { full, mtimeMs: info.mtimeMs };
    } catch {
      // 读不到就跳过这一个文件，不影响整体判断。
    }
  }
  return best?.full;
}

// ---------------------------------------------------------------------------
// 事实收集
// ---------------------------------------------------------------------------

async function locateNapcatDir() {
  const explicit = String(args.values.napcat ?? process.env.QQBOT_NAPCAT_DIR ?? '').trim();
  if (explicit.length > 0) {
    const dir = resolve(explicit);
    // 明确指过但不存在，是**已知缺失**（'' 而不是 undefined）：doctor 该报出来。
    return existsSync(dir) ? dir : '';
  }
  const candidates = [join(repoRoot, 'NapCat.Shell'), join(cwd, 'NapCat.Shell'), join(homedir(), 'NapCat.Shell')];
  return await findNapcatDir(candidates);
}

async function collectNapcat(platform) {
  const dir = await locateNapcatDir();
  if (dir === undefined) {
    // Linux 上 NapCat 通常在容器里，没有本地目录是正常形态；Windows 上找不到就是问题。
    return { napcatDir: platform.os === 'win32' ? '' : undefined };
  }
  if (dir === '') return { napcatDir: '' };
  const configDir = join(dir, 'config');
  const inspection = await inspectNapcat({ dir: configDir, endpoint, token: explicitToken });
  const facts = { napcatDir: dir, napcatConfigFile: inspection.file, napcatLogDir: join(dir, 'logs') };
  if (inspection.found === true) {
    facts.napcatConfigPresent = true;
    // 配置在但读不成 JSON 时 verdict 是 undefined：那是「需要修」，不是「没问题」。
    facts.napcatConfigured = inspection.verdict === undefined ? false : inspection.verdict.ok === true;
  } else if (inspection.noAccount === true) {
    facts.napcatConfigPresent = false;
  }
  return facts;
}

function collectProfileFacts(platform) {
  const dir = platform.profileDir;
  if (typeof dir !== 'string' || dir.length === 0) return {};
  const facts = { profileDir: dir };
  if (!existsSync(dir)) {
    // 桌面版没这个 profile = 装什么都没用；Linux 上可能只是不用这个 profile（比如 headless），不当成病。
    return platform.os === 'win32' ? { ...facts, profileLinkState: 'missing', profileManifestInstalled: false } : facts;
  }
  const manifestPath = join(dir, 'package.json');
  const manifestText = readText(manifestPath);
  let manifestInstalled;
  if (manifestText !== undefined) {
    try {
      // 只读地问一次「装齐了吗」：与真正写盘用的是同一个纯函数（desktop.js），两边不会漂移。
      manifestInstalled = withPluginInstalled(JSON.parse(manifestText), repoRoot).changed === false;
    } catch {
      manifestInstalled = undefined;
    }
  }
  const linkPath = join(dir, 'node_modules', ...PLUGIN_NAME.split('/'));
  const link = pluginLinkState(linkPath, repoRoot, { lstatSync, readlinkSync, realpathSync });
  return {
    ...facts,
    profileManifestInstalled: manifestInstalled,
    profileLinkState: link.state,
    profileLinkTarget: link.target,
    profileLinkPath: linkPath,
  };
}

function collectEnvFacts(platform) {
  const cwdEnv = join(cwd, '.env');
  const profileEnv = typeof platform.profileDir === 'string' && platform.profileDir.length > 0
    ? join(platform.profileDir, '.env')
    : '';
  const cwdHas = existsSync(cwdEnv);
  const profileHas = profileEnv.length > 0 && existsSync(profileEnv);
  return { envPresent: cwdHas || profileHas, envFile: cwdHas ? cwdEnv : (profileEnv.length > 0 ? profileEnv : cwdEnv) };
}

/**
 * 凭据「能不能用」的判据刻意只到「存在且像是 deepseek 的」。
 *
 * 不真的发一次请求：运维脚本不该为了体检消耗一次模型调用，而 DSH 的凭据层每次请求都会
 * 自己 resolve。环境变量优先（DSH 子进程里它可能被 scrub 掉 —— 那时就靠凭据文件）。
 */
function credentialsUsable() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv.length > 0) return true;
  const text = readText(join(dshHome(), '.credentials.yaml'));
  if (text === undefined) return false;
  if (text.trim().length === 0) return false;
  return /deepseek/i.test(text);
}

/** `allowTools:` 那一段里的名字；没有这一段时 undefined（= 这份文件不管这件事）。 */
function parseAllowTools(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*allowTools\s*:\s*(\[\s*\])?\s*$/.test(line));
  if (start === -1) return undefined;
  if (/\[\s*\]\s*$/.test(lines[start])) return [];
  const names = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const match = /^\s*-\s*['"]?([A-Za-z0-9_.:-]+)['"]?\s*(?:#.*)?$/.exec(line);
    if (match === null) break;
    names.push(match[1]);
  }
  return names;
}

/** `tools.js` 里声明了哪些工具（文本扫描，不 import —— 它依赖 `@deepseek-ai/dsh-tools`）。 */
function declaredToolNames() {
  const text = readText(join(repoRoot, 'tools.js'));
  if (text === undefined) return undefined;
  const names = new Set();
  for (const match of text.matchAll(/\bname:\s*'([A-Za-z0-9_]+)'/g)) names.add(match[1]);
  return names;
}

/**
 * 配置里有、代码里没有的工具名（最典型：JM 移除后 `qq_jm_pdf` 还躺在 allowTools 里）。
 *
 * 只判 `qq_*`：白名单里还有 read / web_search / skill 这些**宿主平面**的工具，
 * 它们不在这份仓库的 tools.js 里，拿代码名单去比会全部误报。
 */
function staleToolAllowlist() {
  const candidates = [join(profileDir(), 'cordis.patch.yml'), join(cwd, 'cordis.patch.yml')];
  let allow;
  for (const file of candidates) {
    const text = readText(file);
    if (text === undefined) continue;
    const names = parseAllowTools(text);
    // profile 的 patch 是**整块替换**（AGENTS.md §5.10）：它带 allowTools 就以它为准。
    if (names !== undefined) {
      allow = names;
      break;
    }
  }
  if (allow === undefined) return undefined;
  const declared = declaredToolNames();
  if (declared === undefined) return undefined;
  return allow.filter((name) => name.startsWith('qq_') && !declared.has(name));
}

const PEER_PACKAGES = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm'];

function missingPeerDeps() {
  return PEER_PACKAGES.filter((name) => !existsSync(join(repoRoot, 'node_modules', ...name.split('/'))));
}

function logFacts(platform, facts) {
  if (platform.container === true) {
    return { logsHint: `docker logs --tail ${logLines} ${containerName()}` };
  }
  if (platform.os === 'win32') {
    const explicit = napcatLogFile();
    if (explicit.length > 0) return { logsPath: explicit };
    const dir = typeof facts.napcatDir === 'string' && facts.napcatDir.length > 0 ? join(facts.napcatDir, 'logs') : '';
    const newest = dir.length > 0 ? newestFile(dir) : undefined;
    return newest !== undefined
      ? { logsPath: newest }
      : { logsHint: 'NapCat 的 logs 目录（用 --log-file 指定具体文件；Electron 自己的日志在桌面版数据目录）' };
  }
  if (platform.os === 'linux') {
    return {
      logsHint: platform.systemd === true
        ? `journalctl --user -u ${unitName()} -n ${logLines}`
        : '插件前台运行时的 stderr（在 tmux 面板里）',
    };
  }
  return {};
}

/**
 * 长期记忆的体检事实：认知库与表情包目录里那些「文件在、但不生效」的问题。
 *
 * 只按默认的 `.qq-memory` 找：脚本不解析插件配置（零依赖、不读 YAML），读错了也只影响
 * 报告，不影响插件真正的读写路径。
 * @param root - 部署的 cwd。
 * @returns 可直接合并进 doctor facts 的字段。
 */
async function collectMemoryFacts(root) {
  const dir = join(root, '.qq-memory');
  const facts = {};
  const cognition = await readTextOrUndefined(join(dir, 'COGNITION.md'));
  if (cognition !== undefined) {
    const parsed = parseCognition(cognition);
    facts.cognitionWarnings = parsed.warnings;
    facts.cognitionDuplicateSections = duplicateSectionNames(cognition);
    facts.cognitionPathViolations = cognitionPathViolations(parsed.entries).map((item) => item.path);
  }
  const stickers = await readTextOrUndefined(join(dir, 'STICKERS.md'));
  if (stickers !== undefined) {
    const parsed = parseStickerCatalog(stickers);
    const missing = [];
    const mediaPaths = [];
    for (const entry of parsed.collected) {
      if (String(entry.path ?? '').startsWith('.qq-media/')) mediaPaths.push(entry.name);
      else if (!existsSync(join(root, String(entry.path ?? '')))) missing.push(entry.path);
    }
    facts.stickerMissing = missing;
    facts.stickerMediaPaths = mediaPaths;
  }
  return facts;
}

async function collectFacts(platform) {
  const facts = { ...platform, unit: unitName(), endpoint };
  facts.endpointReachable = await probeEndpoint(endpoint);
  Object.assign(facts, await collectNapcat(platform));
  Object.assign(facts, await collectMemoryFacts(cwd));
  if (platform.systemd === true) {
    facts.systemdUnitPresent = existsSync(systemdUnitPath());
    // unit 不在时不再探 is-active：`systemctl` 对不存在的 unit 也回 inactive，
    // 那会把「没装」说成「没在跑」，根因反而看不清。
    facts.systemdUnitActive = facts.systemdUnitPresent ? systemdIsActive() : false;
    facts.systemdUnitEnabled = systemdIsEnabled();
    facts.lingering = lingeringEnabled();
    facts.journalProblem = journalProblem();
  }
  Object.assign(facts, collectProfileFacts(platform));
  Object.assign(facts, collectEnvFacts(platform));
  facts.credentialsUsable = credentialsUsable();
  const poolPath = join(cwd, 'data', 'api-keys.txt');
  facts.keyPoolPath = poolPath;
  facts.keyPoolPresent = existsSync(poolPath);
  if (facts.keyPoolPresent) {
    const text = await readTextOrUndefined(poolPath);
    if (text !== undefined) facts.keyPoolSize = parseApiKeyPool(text).length;
  }
  facts.staleToolAllowlist = staleToolAllowlist();
  facts.peerDepsMissing = missingPeerDeps();
  facts.cwdWritable = isWritable(cwd);
  Object.assign(facts, logFacts(platform, facts));
  return facts;
}

// ---------------------------------------------------------------------------
// cwd 内的修复（doctor --fix / install --apply 共用）
// ---------------------------------------------------------------------------

function dataDir() {
  return join(cwd, 'data');
}

function envExampleFile() {
  return join(cwd, '.env.example');
}

function mkdirCommandFor(dir) {
  return process.platform === 'win32'
    ? `powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null"`
    : `mkdir -p ${dir}`;
}

function ensureDataDir() {
  const dir = dataDir();
  if (existsSync(dir)) return { status: 'skipped', path: dir, note: 'data/ 已经在了' };
  try {
    mkdirSync(dir, { recursive: true });
    return { status: 'done', path: dir, note: `已建 ${dir}` };
  } catch (error) {
    return { status: 'failed', path: dir, note: `建不了 ${dir}：${errorText(error)}` };
  }
}

function ensureEnvExample() {
  const file = envExampleFile();
  if (existsSync(file)) return { status: 'skipped', path: file, note: '.env.example 已经在了（没动它）' };
  const values = {
    QQBOT_ENDPOINT: endpoint,
    QQBOT_ACCESS_TOKEN: '',
    QQBOT_CWD: cwd,
    QQBOT_NAPCAT_DIR: '',
    QQBOT_RESET_USERS: '',
  };
  const text = [
    '# 本机 QQBOT_* 的模板：复制成 .env（systemd 部署）或写进 profile 的 .env（桌面版）再填。',
    '# 只在 DSH 启动时读一次，改完要重启。空值 = 用插件的平台默认值。',
    '# 真实的 token / key 不要写进仓库（.env 已被 .gitignore 盖住，这个模板也不会写真实值）。',
    '',
    applyEnvBlock('', values),
  ].join('\n');
  try {
    writeFileSync(file, text, 'utf8');
    return { status: 'done', path: file, note: `已写 ${file}（只列名字与默认值）` };
  } catch (error) {
    return { status: 'failed', path: file, note: `写不了 ${file}：${errorText(error)}` };
  }
}

/** 步骤 id → 处理器：写文件这类事不经过 shell，所以不走 argv 那条路。 */
const WORKSPACE_HANDLERS = {
  'ensure-data-dir': ensureDataDir,
  'ensure-env-example': ensureEnvExample,
};

function workspaceFixSteps() {
  const out = [];
  for (const [id, handler] of Object.entries(WORKSPACE_HANDLERS)) {
    const result = handler();
    out.push({
      id,
      status: result.status,
      requires: 'workspace',
      command: id === 'ensure-data-dir' ? mkdirCommandFor(dataDir()) : 'node scripts/ops.mjs doctor --fix',
      note: result.note,
      argv: [],
      optional: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 跑一组步骤，但**只**跑 `only` 里列出的那类。
 *
 * 其余标记 `refused`（不是 skipped）：它没做，而且也不会被自动做 —— 退出码 2 就是
 * 靠这个区别把「需要人上手」和「已经做过」分开的。
 */
async function executeSteps(steps, options = {}) {
  const only = Array.isArray(options.only) ? options.only : ['workspace'];
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 15000;
  const out = [];
  for (const item of steps) {
    if (item.status === 'done' || item.status === 'skipped') {
      out.push(item);
      continue;
    }
    if (!only.includes(item.requires)) {
      out.push({ ...item, status: 'refused' });
      const command = item.command.length > 0 ? `命令：${item.command}` : `说明：${item.note}`;
      say(`— 不执行 ${item.id}（${whoLabel(item.requires)}）：${command}`);
      continue;
    }
    const handler = WORKSPACE_HANDLERS[item.id];
    if (handler !== undefined) {
      const result = handler();
      out.push({ ...item, status: result.status, note: result.note });
      say(`— ${item.id}：${result.note}`);
      continue;
    }
    if (!Array.isArray(item.argv) || item.argv.length === 0) {
      out.push({ ...item, status: 'refused' });
      say(`— ${item.id}：留在计划里，复制出去自己跑（${item.note}）`);
      continue;
    }
    say(`— 执行 ${item.id}：${item.command}`);
    const result = runCapture(item.argv[0], item.argv.slice(1), timeout);
    // 输出收进 JSON 前先截断：`logs -n 10000` 能把一个对象撑到几 MB，agent 读它比没读更糟。
    const output = [result.stdout, result.stderr]
      .map((text) => String(text ?? '').trim())
      .filter((text) => text.length > 0)
      .join('\n')
      .split(/\r?\n/)
      .slice(0, 400)
      .join('\n');
    out.push({ ...item, status: result.ok ? 'done' : 'failed', output });
    if (output.length > 0) say(indent(output));
    if (!result.ok) say(`  （退出码 ${result.status ?? '起不来'}）`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 平台描述
// ---------------------------------------------------------------------------

function describePlatform(platform) {
  const bits = [];
  if (platform.container === true) bits.push('容器（NapCat 在 docker 里）');
  else if (platform.os === 'win32') bits.push('Windows 桌面版');
  else if (platform.os === 'linux') bits.push('Linux');
  else bits.push(String(platform.os));
  if (platform.wsl === true) bits.push('WSL');
  if (platform.systemd === true) bits.push('有 systemd 用户会话');
  if (platform.schtasks === true) bits.push('有 schtasks');
  if (platform.elevated === true) bits.push('已提权');
  if (typeof platform.profileDir === 'string' && platform.profileDir.length > 0) bits.push(`profile：${platform.profileDir}`);
  bits.push(`cwd：${platform.cwd || cwd}`);
  return bits.join('；');
}

async function detect() {
  const os = process.platform;
  // 一律探一次：platform 是 JSON 协议的一部分，同一个部署不该因为命令不同而报出两种平台形状。
  // 探不到 docker（没装 / 没权限 / 守护进程没起）就是「不是容器」—— 那也正好是事实。
  const container = containerForced() || napcatContainerExists();
  return detectPlatform({
    platform: os,
    env: process.env,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    hasSystemctl: hasSystemdSession(),
    hasSchtasks: os === 'win32',
    container,
    cwd,
    profileDir: profileDir(),
  });
}

function minimalPlatform() {
  return detectPlatform({
    platform: process.platform,
    env: process.env,
    cwd,
    profileDir: profileDir(),
    hasSystemctl: false,
    hasSchtasks: process.platform === 'win32',
    container: containerForced(),
  });
}

function planPaths(platform, facts = {}) {
  return {
    unit: unitName(),
    unitPath: systemdUnitPath(),
    unitDir: dirname(systemdUnitPath()),
    servicePath: join(repoRoot, 'deploy', 'qqbot.service'),
    taskName: taskName(),
    containerName: containerName(),
    cwd,
    repoRoot,
    profileName: profileName(),
    profileDir: profileDir(),
    napcatDir: typeof facts.napcatDir === 'string' ? facts.napcatDir : '',
    qq: qqNumber(),
    endpoint,
    logLines,
    logFile: napcatLogFile(),
  };
}

// ---------------------------------------------------------------------------
// 命令：doctor
// ---------------------------------------------------------------------------

async function commandDoctor(platform) {
  const facts = await collectFacts(platform);
  const findings = doctorFindings(facts);
  const steps = doctorSteps(findings);
  printFindings(findings);
  if (args.flags.has('fix')) {
    say('— 只修 cwd 内能修的东西（data/、.env.example）—');
    // 修复步骤放最前面：它们是脚本自己刚做完的事，后面的「等你复制」才好读。
    steps.unshift(...workspaceFixSteps());
    if (Array.isArray(facts.peerDepsMissing) && facts.peerDepsMissing.length > 0) {
      say(`注意：缺 Harness 注入的包（${facts.peerDepsMissing.join(' / ')}）。这一步要人做（见上面的 DEPS_MISSING），脚本不碰 node_modules。`);
    }
  } else if (findings.some((item) => item.requires === 'workspace' && (item.code === 'ENV_MISSING' || item.code === 'KEY_POOL_MISSING'))) {
    say('提示：有些问题脚本能在 cwd 内自己修（node scripts/ops.mjs doctor --fix）。');
  }
  if (steps.length > 0) printSteps(steps);
  return conclude('doctor', platform, { findings, steps });
}

// ---------------------------------------------------------------------------
// 命令：status / restart / logs
// ---------------------------------------------------------------------------

async function commandStatus(platform) {
  const facts = await collectFacts(platform);
  const findings = doctorFindings(facts);
  printFindings(findings);
  say('— 服务状态 —');
  const steps = await executeSteps(servicePlan('status', platform, planPaths(platform, facts)));
  return conclude('status', platform, { findings, steps });
}

async function commandRestart(platform) {
  const facts = await collectFacts(platform);
  say('— 重启 —');
  const steps = await executeSteps(servicePlan('restart', platform, planPaths(platform, facts)), { timeout: 30000 });
  if (platform.container === true) {
    // 容器重启是人工步骤；这里只说明为什么不代跑，避免用户以为「点了没反应」。
    say('容器版的重启要人自己跑 docker restart（见上面的命令）。');
  } else if (platform.os === 'win32') {
    say('Windows 桌面版不能由脚本重启（那会连 UI 一起杀掉）：请手动重启桌面版。');
  }
  if (platform.systemd === true) {
    const active = systemdIsActive();
    if (active === true) say('服务现在是 active。');
    else if (active === false) say('注意：restart 之后它还不是 active —— 用 node scripts/ops.mjs logs -n 100 看现场。');
    else say('查不到 is-active（systemctl 起不来？）。');
  }
  printSteps(steps);
  return conclude('restart', platform, { steps });
}

async function commandLogs(platform) {
  const facts = await collectFacts(platform);
  const steps = await executeSteps(servicePlan('logs', platform, planPaths(platform, facts)), { timeout: 20000 });
  return conclude('logs', platform, { steps });
}

// ---------------------------------------------------------------------------
// 命令：install / uninstall
// ---------------------------------------------------------------------------

async function scheduledTaskExists() {
  if (process.platform !== 'win32') return false;
  const plan = scheduledTaskQueryPlan({ taskName: taskName() });
  return runCapture(plan.command, plan.args, 5000).ok;
}

/** 已经做完的步骤 id：判据全部来自磁盘/服务，不来自上一次运行的记忆（脚本没有状态）。 */
async function collectDoneSteps(platform, facts) {
  const done = [];
  if (existsSync(dataDir())) done.push('ensure-data-dir');
  if (existsSync(envExampleFile())) done.push('ensure-env-example');
  if (platform.systemd === true) {
    if (existsSync(systemdUnitPath())) done.push('write-unit');
    // install 里的 enable 还带 `--now`：只 enable 不 active 的话，它还没做完。
    if (facts.systemdUnitEnabled === true && facts.systemdUnitActive === true) done.push('systemd-enable');
    if (facts.systemdUnitEnabled === true) done.push('systemd-enable-autostart');
    if (facts.lingering === true) done.push('systemd-linger');
  }
  if (facts.profileLinkState === 'linked' && facts.profileManifestInstalled === true) done.push('install-profile');
  if (facts.napcatConfigured === true) done.push('napcat-config');
  if (platform.os === 'win32') {
    if (await scheduledTaskExists()) {
      done.push('register-autostart');
      done.push('write-autostart-files');
    } else if (typeof facts.napcatDir === 'string' && facts.napcatDir.length > 0
      && existsSync(join(facts.napcatDir, HIDDEN_WRAPPER_NAME))) {
      done.push('write-autostart-files');
    }
  }
  if (platform.container === true) done.push('container-run');
  return done;
}

function skipSteps(steps, ids) {
  const done = new Set(ids.map(String));
  return steps.map((item) => (done.has(item.id)
    ? { ...item, status: 'skipped', note: item.note.length > 0 ? `${item.note}（已经不需要做了，跳过）` : '已经不需要做了，跳过' }
    : item));
}

async function commandInstall(platform) {
  const facts = await collectFacts(platform);
  const doneStepIds = await collectDoneSteps(platform, facts);
  const steps = installPlan(platform, {
    ...planPaths(platform, facts),
    cwd,
    doneStepIds,
  });
  if (!applyMode) {
    say('这是计划，什么都没写。');
    say('--apply 只会执行 workspace 里的步骤；写 systemd / 计划任务 / profile 的命令会原样列出来，复制出去自己跑。');
  }
  const executed = applyMode ? await executeSteps(steps) : steps;
  printSteps(executed);
  return conclude('install', platform, { steps: executed });
}

async function commandUninstall(platform) {
  const facts = await collectFacts(platform);
  const obsolete = [];
  if (platform.systemd === true) {
    if (!existsSync(systemdUnitPath())) {
      obsolete.push('remove-unit');
      obsolete.push('systemd-disable');
    } else if (facts.systemdUnitEnabled === false) {
      obsolete.push('systemd-disable');
    }
  }
  if (platform.os === 'win32' && !(await scheduledTaskExists())) obsolete.push('delete-autostart');
  const steps = skipSteps(servicePlan('uninstall', platform, planPaths(platform, facts)), obsolete);
  if (!applyMode) say('这是计划，什么都没删。卸载动的是 cwd 外的系统服务 / 计划任务，脚本一律只打印命令。');
  const executed = applyMode ? await executeSteps(steps) : steps;
  printSteps(executed);
  return conclude('uninstall', platform, { steps: executed });
}

// ---------------------------------------------------------------------------
// 命令：napcat
// ---------------------------------------------------------------------------

const NAPCAT_SUBS = ['config', 'start', 'autologin', 'webui'];

function pickLauncher(dir) {
  for (const name of ['launcher.bat', 'launcher-user.bat']) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return '';
}

function backupName(file) {
  return `${file}.bak-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
}

/** NapCat 配置目录里的账号号（`--qq` 没给时兜底用）。 */
async function napcatAccounts(dir) {
  try {
    return accountFiles(readdirSync(join(dir, 'config')));
  } catch {
    return [];
  }
}

function napcatStep(id, status, requires, command, note, argv) {
  return {
    id,
    status,
    requires,
    command: String(command ?? ''),
    note: String(note ?? ''),
    argv: Array.isArray(argv) ? argv : [],
    optional: false,
  };
}

async function commandNapcat(platform, sub) {
  if (!NAPCAT_SUBS.includes(sub)) {
    return fail('napcat', platform, `napcat 后面要跟 ${NAPCAT_SUBS.join(' / ')}（拿到的是「${sub ?? ''}」）`);
  }
  const dir = await locateNapcatDir();
  if (typeof dir !== 'string' || dir.length === 0) {
    // 容器版：配置在容器里，宿主机上本来就没有这个目录 —— 直接说清两条出路。
    const note = platform.container === true
      ? 'NapCat 在容器里，配置在容器内：把 config 挂出来（-v ~/napcat/config:/app/napcat/config）后用 --napcat <挂载目录> 重跑，或进容器改（docker exec -it napcat sh）'
      : dir === ''
        ? '指定的 NapCat 目录不存在：用 --napcat <目录> 指到解压出来的 NapCat.Shell'
        : '没找到 NapCat 安装目录：用 --napcat <目录> 指定，或把 NapCat.Shell 解压到仓库根目录';
    return conclude(`napcat ${sub}`, platform, {
      steps: [napcatStep(`napcat-dir`, 'refused', 'human', '', note)],
    });
  }
  const configDir = join(dir, 'config');
  if (sub === 'webui') return napcatWebui(platform, configDir);
  if (sub === 'start') return napcatStart(platform, dir);
  if (sub === 'autologin') return napcatAutologin(platform, dir, configDir);
  return napcatConfig(platform, dir, configDir);
}

async function napcatWebui(platform, configDir) {
  const file = join(configDir, 'webui.json');
  const text = await readTextOrUndefined(file);
  if (text === undefined) {
    return conclude('napcat webui', platform, {
      steps: [napcatStep('napcat-webui', 'refused', 'human', '', `还没有 ${file}（NapCat 启动过一次才会生成）：先把它跑起来再问 WebUI 地址`)],
    });
  }
  let target;
  try {
    target = webuiTarget(JSON.parse(text));
  } catch (error) {
    return conclude('napcat webui', platform, {
      steps: [napcatStep('napcat-webui', 'failed', 'human', '', `${file} 不是合法 JSON：${errorText(error)}`)],
    });
  }
  if (target === undefined) {
    return conclude('napcat webui', platform, {
      steps: [napcatStep('napcat-webui', 'refused', 'human', '', `${file} 里读不出 host/port（NapCat 可能还没初始化完）`)],
    });
  }
  const output = `WebUI：${target.url}${target.token.length > 0 ? `（token：${target.token}）` : ''}`;
  say(output);
  // 只读：token 就在本机这个文件里，打印它是这个子命令存在的意义（窗口藏起来之后 WebUI 是唯一的"控制台"）。
  return conclude('napcat webui', platform, {
    steps: [napcatStep('napcat-webui', 'done', 'workspace', '', output)],
  });
}

async function napcatConfig(platform, dir, configDir) {
  const inspection = await inspectNapcat({ dir: configDir, endpoint, token: explicitToken });
  if (inspection.found !== true) {
    return conclude('napcat config', platform, {
      steps: [napcatStep('napcat-config', 'refused', 'human', '', inspection.reason ?? '读不到 OneBot 配置（NapCat 还没登录过账号？先启动一次并扫码）')],
    });
  }
  // 没显式给 token 时，把 NapCat 现有那一条的 token 当成期望值：凭「token 不一致」去修会把
  // 用户设的 token 抹成空串，而插件真正的 token 在 .env 里 —— 按纪律这里不读它的明文。
  let token = explicitToken;
  const matchedToken = String(inspection.verdict?.matched?.token ?? '');
  if (token.length === 0 && matchedToken.length > 0) token = matchedToken;
  const repair = await repairNapcat({ dir: configDir, endpoint, token, qq: qqNumber(), autoConfig: applyMode });
  const verdict = repair.verdict?.reason ?? '';
  const notes = Array.isArray(repair.verdict?.notes) && repair.verdict.notes.length > 0
    ? `；另注意：${repair.verdict.notes.join('；')}`
    : '';
  if (!applyMode) {
    const status = repair.action === 'ok' ? 'skipped' : 'planned';
    const note = repair.action === 'ok'
      ? `已经是配好的：${repair.file}`
      : `会改 ${repair.file}（${verdict || repair.reason}）${notes}。加 --apply 才写；改前自动备份`;
    if (status === 'planned') say('这是计划，什么都没写。加 --apply 才会改 NapCat 的配置（cwd 外）。');
    return conclude('napcat config', platform, { steps: [napcatStep('napcat-config', status, 'human', '', note)] });
  }
  if (repair.action === 'repaired') {
    say(`已改好 ${repair.file}（原因：${verdict}；原文件备份在 ${repair.backup}）${notes}`);
    return conclude('napcat config', platform, {
      steps: [napcatStep('napcat-config', 'done', 'human', '', `已写 ${repair.file}（备份：${repair.backup}）${notes}`)],
    });
  }
  if (repair.action === 'ok') {
    say(`不用改：${repair.file} 已经对得上`);
    return conclude('napcat config', platform, {
      steps: [napcatStep('napcat-config', 'skipped', 'human', '', `已经是配好的：${repair.file}`)],
    });
  }
  const why = repair.reason ?? (repair.action === 'needs-repair' ? '需要修' : '查不出来');
  return conclude('napcat config', platform, {
    steps: [napcatStep('napcat-config', 'refused', 'human', '', `没能修：${why}${notes}`)],
  });
}

async function napcatAutologin(platform, dir, configDir) {
  const file = join(configDir, 'webui.json');
  const accounts = await napcatAccounts(dir);
  const wanted = qqNumber() || String(accounts[0]?.qq ?? '');
  if (wanted.length === 0) {
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'refused', 'human', '', '不知道要自动登录哪个号：加 --qq <号>（或先让 NapCat 登录一次，config 里就会有账号文件）')],
    });
  }
  const text = await readTextOrUndefined(file);
  if (text === undefined) {
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'refused', 'human', '', `还没有 ${file}（NapCat 启动过一次才会生成）：先登录一次再回来设置快速登录`)],
    });
  }
  let current;
  try {
    current = JSON.parse(text);
  } catch (error) {
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'failed', 'human', '', `${file} 不是合法 JSON：${errorText(error)}（没动它）`)],
    });
  }
  const patched = withAutoLoginAccount(current, wanted);
  if (!patched.changed) {
    say(`${file} 里已经是自动快速登录 ${wanted}，不动它`);
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'skipped', 'human', '', `已经是 ${wanted} 了`)],
    });
  }
  if (!applyMode) {
    say('这是计划，什么都没写。加 --apply 才会改 webui.json（cwd 外）。');
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'planned', 'human', '', `会把 autoLoginAccount 设成 ${wanted}（${file}；改前备份）`)],
    });
  }
  const backup = backupName(file);
  try {
    copyFileSync(file, backup);
    await writeJsonAtomic(file, patched.config);
    say(`已设置自动快速登录 ${wanted}（${file}；原文件备份在 ${backup}）`);
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'done', 'human', '', `已设置 ${wanted}（备份：${backup}）`)],
    });
  } catch (error) {
    return conclude('napcat autologin', platform, {
      steps: [napcatStep('napcat-autologin', 'failed', 'human', '', `写不进去：${errorText(error)}（原文件没被改，备份在 ${backup}）`)],
    });
  }
}

async function napcatStart(platform, dir) {
  const launcher = pickLauncher(dir);
  const windowMode = String(args.values.window ?? 'min').trim();
  let plan;
  if (windowMode === 'hidden') {
    const wrapper = join(dir, HIDDEN_WRAPPER_NAME);
    plan = existsSync(wrapper)
      ? hiddenStartPlan({ platform: process.platform, wrapper, qq: qqNumber() })
      : { unsupported: `隐藏启动需要包装脚本 ${wrapper}：先跑 node scripts/napcat-setup.mjs --autostart install（或 --window hidden 生成它）` };
  } else {
    plan = startPlan({ platform: process.platform, launcher, qq: qqNumber(), windowMode });
  }
  if (plan.unsupported !== undefined || renderPlan(plan).length === 0) {
    return conclude('napcat start', platform, {
      steps: [napcatStep('napcat-start', 'refused', 'human', '', plan.unsupported ?? '算不出启动命令')],
    });
  }
  const command = renderPlan(plan);
  if (!applyMode) {
    say('这是计划，什么都没启动。加 --apply 才会真的拉起 NapCat（会弹 UAC，点「是」）。');
    return conclude('napcat start', platform, {
      steps: [napcatStep('napcat-start', 'planned', 'human', command, plan.describe ?? '启动 NapCat')],
    });
  }
  const launched = await spawnDetached(plan.command, plan.args);
  say(launched.ok ? `${plan.describe ?? '启动 NapCat'} —— 已发出（UAC 弹窗点「是」）` : `起不来：${launched.message}`);
  return conclude('napcat start', platform, {
    steps: [napcatStep('napcat-start', launched.ok ? 'done' : 'failed', 'human', command, launched.message)],
  });
}

// ---------------------------------------------------------------------------
// 命令：migrate
// ---------------------------------------------------------------------------

/** 「认知迁移」的交付物在 scripts/migrate-cognition.mjs；还没落地时这里给一条清楚的话 + 3。 */
async function loadMigrationModule() {
  try {
    return { module: await import(new URL('./migrate-cognition.mjs', import.meta.url).href) };
  } catch (error) {
    return {
      error: `迁移脚本还没落地（scripts/migrate-cognition.mjs 不存在或 import 失败）：这是 P1 认知拆分的交付物，落地之后这条命令会自动可用。原始错误：${errorText(error)}`,
    };
  }
}

function normalizeMigrationSteps(raw, prefix) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.steps) ? raw.steps : []);
  return list.map((item, index) => {
    const source = item ?? {};
    return {
      id: String(source.id ?? `${prefix}-${index + 1}`),
      // 迁移只写 cwd 内的记忆目录；模块自己说 human/root 时**尊重**它（那是它更清楚）。
      status: typeof source.status === 'string' ? source.status : 'planned',
      requires: source.requires === 'human' || source.requires === 'root' ? source.requires : 'workspace',
      command: String(source.command ?? ''),
      note: String(source.note ?? source.message ?? ''),
      argv: Array.isArray(source.argv) ? source.argv.map(String) : [],
      optional: source.optional === true,
    };
  });
}

function migrationFindings(raw) {
  if (raw === undefined || raw === null || Array.isArray(raw)) return [];
  return Array.isArray(raw.findings) ? raw.findings : [];
}

async function commandMigrate(platform, sub) {
  if (sub !== 'cognition') {
    return fail('migrate', platform, `migrate 后面要跟 cognition（拿到的是「${sub ?? ''}」）；这条命令只做认知库迁移`);
  }
  const loaded = await loadMigrationModule();
  if (loaded.error !== undefined) return fail('migrate cognition', platform, loaded.error);
  const mod = loaded.module ?? {};
  if (typeof mod.planCognitionMigration !== 'function') {
    return fail('migrate cognition', platform, 'scripts/migrate-cognition.mjs 没有导出 planCognitionMigration()：模块契约不对（应当是纯计划函数）');
  }
  // 记忆目录 / 表情包目录都是相对 cwd 的（模块自己 resolve；这里不猜绝对路径）。
  const plan = await mod.planCognitionMigration({ cwd, memoryDir: '.qq-memory', stickerDir: '.qq-stickers' });
  if (plan === null || typeof plan !== 'object') {
    return fail('migrate cognition', platform, 'planCognitionMigration() 没返回计划对象：模块契约不对');
  }
  // 两种契约都认：① 直接给 steps / findings（纯计划层最常见的形状）；
  // ② 给 { stats, entries, next }（scripts/migrate-cognition.mjs 现在的形状）——
  //    后者更适合「一次迁移」这件事，硬逼它改形状只会让两边各写一份统计。
  const summary = typeof plan.stats === 'object' && plan.stats !== null ? plan.stats : undefined;
  const findings = migrationFindings(plan);
  const steps = summary !== undefined
    ? cognitionSummarySteps(plan, summary)
    : normalizeMigrationSteps(plan, 'migrate-step');
  for (const entry of Array.isArray(plan.entries) ? plan.entries : []) {
    if (entry?.action !== 'needs-human') continue;
    if (findings.length >= 20) break;
    // 模块的 entry 里没有序号（它自己也不该为了报告去编号），所以用「键 + 写法」指认那一条。
    const label = String(entry.sticker ?? entry.path ?? entry.writeup ?? entry.meaning ?? '').slice(0, 80);
    findings.push({
      level: 'warn',
      code: 'COGNITION_UNRESOLVED',
      requires: 'human',
      message: `认不出对应的收藏图：${label.length > 0 ? label : '（这条条目没有留下可取的名字）'}`,
      fix: '把那张表情包重新收藏（qq_save_sticker）后重跑一次，或手工补进 STICKERS.md；不补也能用，只是这条记忆还指着路径',
    });
  }
  if (summary === undefined && steps.length === 0) {
    say('迁移脚本没给出任何步骤（也没什么可迁的）。');
  }
  const target = steps[0];
  // 没有 COGNITION.md 时计划层把这一步标成 skipped：**不要**再调 apply —— 它会把两份
  // 空内容写进记忆目录，凭空造出一对空文件（比不动更糟）。
  if (applyMode && target !== undefined && target.status === 'skipped') {
    say('没有什么可迁的（没有 COGNITION.md）：一个文件都没动。');
  } else if (applyMode) {
    if (typeof mod.applyCognitionMigration !== 'function') {
      return fail('migrate cognition', platform, 'scripts/migrate-cognition.mjs 没有导出 applyCognitionMigration()：只能预览，加 --apply 也不行');
    }
    // 这个模块的 apply 收的是**计划对象**（它已经把两份文件的新内容算好了）：
    // 所以传 plan，不是传 options。备份在模块里做（写前复制 .bak-<时间戳>）。
    const applied = await mod.applyCognitionMigration(plan);
    if (applied !== null && typeof applied === 'object' && applied.ok === false) {
      if (target !== undefined) {
        target.status = 'failed';
        target.note = `迁移失败：${String(applied.error ?? '未知原因')}`;
      }
      say(`迁移失败：${String(applied.error ?? '未知原因')}`);
    } else if (target !== undefined) {
      target.status = 'done';
      const backups = Array.isArray(applied?.backups) ? applied.backups : [];
      target.note = [target.note, backups.length > 0 ? `备份：${backups.join(' / ')}` : '原文件不存在，没有产生备份'].join('；');
      say(target.note);
    }
  } else if (target !== undefined) {
    say('这是计划，什么都没写。加 --apply 才会真的迁移（会先把 COGNITION.md / STICKERS.md 备份成 .bak-<时间戳>）。');
  }
  printSteps(steps);
  return conclude('migrate cognition', platform, { findings, steps });
}

/**
 * 把 `planCognitionMigration` 的统计摊成**一条**步骤 + 若干条要人看的 finding。
 *
 * 一条而不是「每条迁移一个步骤」：迁移的粒度是「一次跑完两份文件」，拆成 N 步会让
 * 输出长到没人读，也没法只执行其中一条（apply 本来就是原子的）。
 */
function cognitionSummarySteps(plan, stats) {
  const count = (name) => Number(stats?.[name] ?? 0);
  const summary = `共 ${count('total')} 条：搬走 ${count('moved')} · 留着 ${count('kept')} · 丢掉 ${count('dropped')} · 要人看一眼 ${count('needsHuman')}`;
  const changes = Array.isArray(plan.changes) ? plan.changes : [];
  const detail = changes.length > 0
    ? `${summary}；${changes.slice(0, 10).join('；')}${changes.length > 10 ? `；……另有 ${changes.length - 10} 条` : ''}`
    : summary;
  const note = typeof plan.note === 'string' && plan.note.length > 0 ? `${plan.note}（${detail}）` : detail;
  // 没有 COGNITION.md 时连文件都没有：标 skipped，别让人以为「计划里有一件没做的事」。
  const nothing = typeof plan.note === 'string' && plan.note.length > 0 && count('total') === 0;
  return [{
    id: 'migrate-cognition',
    status: nothing ? 'skipped' : 'planned',
    // 迁移只写 `.qq-memory`（cwd 内）与备份文件，属于脚本自己能做的事。
    requires: 'workspace',
    command: 'node scripts/ops.mjs migrate cognition --apply',
    note,
    argv: [],
    optional: false,
  }];
}

// ---------------------------------------------------------------------------
// 命令：cleanup jm
// ---------------------------------------------------------------------------

/** 递归列文件（深度与条数都有上限：清理的是自己的目录，不该在坏掉的树上转圈）。 */
function listFilesRecursive(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 5000) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      size = 0;
    }
    out.push({ path: full, size });
  }
  return out;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function commandCleanup(platform, sub) {
  if (sub !== 'jm') {
    return fail('cleanup', platform, `cleanup 后面要跟 jm（拿到的是「${sub ?? ''}」）；只删 .qq-jm/，不碰 .venv/`);
  }
  // 只删这一个目录：路径写死并再 resolve 一次确认，拒绝任何「顺着变量走到别处」的可能。
  const dir = join(cwd, '.qq-jm');
  if (resolve(dir) !== resolve(cwd, '.qq-jm')) {
    return fail('cleanup jm', platform, `拒绝执行：目标路径算出来是 ${resolve(dir)}，不是 cwd 下的 .qq-jm`);
  }
  const files = listFilesRecursive(dir);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const command = platform.os === 'win32'
    ? `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -Force"`
    : `rm -rf ${dir}`;
  if (files.length === 0) {
    say('.qq-jm/ 不存在或已经是空的，没什么可删（.venv/ 与其它目录一律不动）。');
    return conclude('cleanup jm', platform, {
      steps: [napcatStep('cleanup-jm', 'skipped', 'human', command, '.qq-jm/ 不存在或已经是空的')],
    });
  }
  say(`.qq-jm/ 里有 ${files.length} 个文件（共 ${formatBytes(total)}）：`);
  for (const file of files.slice(0, 50)) say(`  ${file.path}（${formatBytes(file.size)}）`);
  if (files.length > 50) say(`  …还有 ${files.length - 50} 个没列出来`);
  if (!applyMode) {
    say('只是列出来；加 --apply 才会删（只删 .qq-jm/，不碰 .venv/）。');
    return conclude('cleanup jm', platform, {
      steps: [napcatStep('cleanup-jm', 'planned', 'human', command, `会删掉 ${files.length} 个文件（${formatBytes(total)}），只删 .qq-jm/`)],
    });
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    say(`已删掉 .qq-jm/（${files.length} 个文件，${formatBytes(total)}；.venv/ 没动）。`);
    return conclude('cleanup jm', platform, {
      steps: [napcatStep('cleanup-jm', 'done', 'human', command, `已删掉 ${files.length} 个文件（${formatBytes(total)}）`)],
    });
  } catch (error) {
    return conclude('cleanup jm', platform, {
      steps: [napcatStep('cleanup-jm', 'failed', 'human', command, `删不掉：${errorText(error)}`)],
    });
  }
}

// ---------------------------------------------------------------------------
// 命令：selftest
// ---------------------------------------------------------------------------

/**
 * 自检：用三套平台形状把纯计划跑一遍。
 *
 * 为什么值得有：`ops.mjs` 会因为环境差异（没有 systemd、没有 docker、Windows 路径）
 * 走到很少被走的分支。真出事时用户手上只有这一条命令，所以它得先证明「计划层本身
 * 还能产出完整步骤」，而不是替用户判断机器有没有病（那是 doctor 的事）。
 */
function selftestChecks() {
  const checks = [];
  const push = (name, run) => {
    try {
      checks.push({ name, ok: true, note: run() });
    } catch (error) {
      checks.push({ name, ok: false, note: errorText(error) });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const shapes = {
    linux: detectPlatform({ platform: 'linux', env: { HOME: '/tmp/selftest-home' }, uid: 1000, hasSystemctl: true, cwd: '/tmp/qqbot' }),
    windows: detectPlatform({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\selftest' }, hasSchtasks: true, cwd: 'C:\\qqbot' }),
    container: detectPlatform({ platform: 'linux', env: { HOME: '/tmp/selftest-home' }, container: true, cwd: '/tmp/qqbot' }),
  };
  push('detectPlatform：Linux 形状', () => {
    const p = shapes.linux;
    assert(p.os === 'linux' && p.systemd === true && p.container === false, 'Linux 形状不对');
    return `os=${p.os} systemd=${p.systemd} profile=${p.profileDir}`;
  });
  push('detectPlatform：Windows 形状', () => {
    const p = shapes.windows;
    assert(p.os === 'win32' && p.schtasks === true && p.systemd === false, 'Windows 形状不对');
    return `os=${p.os} schtasks=${p.schtasks} profile=${p.profileDir}`;
  });
  push('servicePlan：三种平台 × 六个动作都有步骤', () => {
    for (const [name, platform] of Object.entries(shapes)) {
      for (const action of ['status', 'restart', 'logs', 'install', 'uninstall', 'autostart']) {
        const steps = servicePlan(action, platform, { cwd: platform.cwd, repoRoot: platform.cwd, napcatDir: platform.os === 'win32' ? 'C:\\NapCat.Shell' : '' });
        assert(steps.length > 0, `${name} / ${action} 没有产出步骤`);
        for (const item of steps) {
          assert(typeof item.id === 'string' && item.id.length > 0, `${name} / ${action} 有步骤缺 id`);
          assert(['workspace', 'human', 'root'].includes(item.requires), `${name} / ${action} / ${item.id} 的 requires 不合法`);
          assert(item.command.length > 0 || item.note.length > 0, `${name} / ${action} / ${item.id} 既没有命令也没有说明`);
          assert(typeof item.optional === 'boolean', `${name} / ${action} / ${item.id} 的 optional 不是布尔`);
        }
      }
    }
    return '18 组计划都完整';
  });
  push('installPlan：cwd 外的写一律标 human/root', () => {
    for (const platform of [shapes.linux, shapes.windows, shapes.container]) {
      const steps = installPlan(platform, { cwd: platform.cwd, repoRoot: platform.cwd, doneStepIds: [] });
      for (const item of steps) {
        // 允许脚本自己跑的只有 cwd 内的准备动作，以及 `verify`（只读体检，不写任何东西）。
        // 其余（unit / 计划任务 / profile / NapCat 配置）必须人来做。
        if (item.id === 'ensure-data-dir' || item.id === 'ensure-env-example' || item.id === 'verify') {
          assert(item.requires === 'workspace', `${item.id} 应当可以由脚本自己做`);
        } else {
          assert(item.requires === 'human' || item.requires === 'root', `${platform.os} 的 ${item.id} 没有标 human/root`);
        }
      }
    }
    return '没有把 cwd 外的写当成 workspace';
  });
  push('installPlan：doneStepIds 会变成 skipped', () => {
    const steps = installPlan(shapes.linux, { cwd: '/tmp/qqbot', repoRoot: '/tmp/qqbot', doneStepIds: ['ensure-data-dir', 'write-unit'] });
    const data = steps.find((item) => item.id === 'ensure-data-dir');
    const unit = steps.find((item) => item.id === 'write-unit');
    assert(data?.status === 'skipped' && unit?.status === 'skipped', '幂等标记没生效');
    return '重复执行不会重复写';
  });
  push('doctorFindings：未知事实不产生 finding', () => {
    assert(doctorFindings({}).length === 0, '空事实居然产出了 finding');
    return '{} → 0 条';
  });
  push('doctorFindings：每条都有 code 与 fix', () => {
    const findings = doctorFindings({
      endpointReachable: false, napcatConfigPresent: false, systemdUnitActive: false,
      profileLinkState: 'missing', envPresent: false, credentialsUsable: false,
      keyPoolPresent: false, staleToolAllowlist: ['qq_jm_pdf'], cwdWritable: false,
    });
    assert(findings.length > 0, '一堆坏事实居然没有 finding');
    for (const item of findings) {
      assert(typeof item.code === 'string' && item.code.length > 0, '有 finding 缺 code');
      assert(typeof item.fix === 'string' && item.fix.length > 0, `${item.code} 缺 fix`);
      assert(['error', 'warn', 'info'].includes(item.level), `${item.code} 的 level 不合法`);
    }
    return `${findings.length} 条都完整`;
  });
  push('exitCodeFor：0 / 1 / 2 / 3', () => {
    assert(exitCodeFor({}) === 0, '干净结果不是 0');
    assert(exitCodeFor({ findings: [{ level: 'error' }] }) === 1, 'error finding 不是 1');
    assert(exitCodeFor({ findings: [{ level: 'warn', requires: 'human' }] }) === 2, '需要人做的 warn 不是 2');
    assert(exitCodeFor({ steps: [{ requires: 'root', status: 'planned' }] }) === 2, 'root 步骤不是 2');
    assert(exitCodeFor({ steps: [{ requires: 'root', status: 'done' }] }) === 0, '做完了还算 2');
    assert(exitCodeFor({ error: 'boom' }) === 3, '脚本错误不是 3');
    return '四种退出码都对';
  });
  push('renderPlan：把 napcat.js 的计划渲染成一行', () => {
    const line = renderPlan({ command: 'schtasks.exe', args: ['/Query', '/TN', TASK_NAME] });
    assert(line.includes('schtasks.exe') && line.includes(TASK_NAME), '渲染丢了命令或参数');
    assert(renderPlan(undefined) === '' && renderPlan({ unsupported: 'x' }) === '', '不可执行的计划应当渲染成空串');
    return line;
  });
  return checks;
}

async function commandSelftest(platform) {
  const checks = selftestChecks();
  const failed = checks.filter((item) => item.ok === false);
  const steps = checks.map((item, index) => ({
    id: `selftest-${index + 1}`,
    status: item.ok ? 'done' : 'failed',
    requires: 'workspace',
    command: '',
    note: `${item.name}：${item.note}`,
    argv: [],
    optional: false,
  }));
  for (const item of steps) say(`${STATUS_LABEL[item.status] ?? item.status}  ${item.note}`);
  return conclude('selftest', platform, {
    steps,
    error: failed.length > 0 ? `自检有 ${failed.length} 条失败` : undefined,
  });
}

// ---------------------------------------------------------------------------
// 用法与入口
// ---------------------------------------------------------------------------

function printUsage() {
  const lines = [
    '用法：',
    '  node scripts/ops.mjs doctor [--json] [--fix]',
    '  node scripts/ops.mjs status [--json]',
    '  node scripts/ops.mjs restart [--json]',
    '  node scripts/ops.mjs logs [-n 100] [--json]',
    '  node scripts/ops.mjs install [--qq <号>] [--apply] [--json]',
    '  node scripts/ops.mjs uninstall [--apply]',
    '  node scripts/ops.mjs napcat config|start|autologin|webui [--apply]',
    '  node scripts/ops.mjs migrate cognition [--apply] [--json]',
    '  node scripts/ops.mjs cleanup jm [--apply] [--json]',
    '  node scripts/ops.mjs selftest [--json]',
    '',
    '通用参数：',
    '  --apply        真的写 / 删（默认只打印计划）',
    '                 install / uninstall：只执行 workspace 步骤，cwd 外的写一律拒绝（退出码 2）',
    '                 napcat / cleanup / migrate：--apply 就是「我授权改 cwd 外 / 删数据」，仍拒绝需要提权的步骤',
    '  --json         只往 stdout 打一个 JSON 对象（schema / ok / action / platform / findings / steps），人话走 stderr',
    '  --fix          doctor 只做 cwd 内的修复（建 data/、写 .env.example）',
    '  --qq <号>      机器人 QQ 号（install / napcat autologin 用）',
    '  --profile <名> DSH profile 名（默认 qqbot）',
    '  --dsh-home <目录>  DSH 家目录（默认 ~/.dsh）',
    '  --cwd <目录>    插件的工作目录（默认当前目录）',
    '  --endpoint <ws://主机:端口>   OneBot 地址（默认 ws://127.0.0.1:3001）',
    '  --token <access_token>      NapCat 的 access_token（不从 .env 读明文）',
    '  --unit <名>     systemd unit 名（默认 qqbot）',
    '  --unit-path <文件>  unit 的落盘位置（默认 ~/.config/systemd/user/<unit>.service）',
    '  --task-name <名>    Windows 计划任务名',
    '  --container[=<名>]  容器模式（NapCat 在 docker 里；默认容器名 napcat）',
    '  --napcat <目录>     NapCat 安装目录',
    '  --log-file <文件>   Windows 上 NapCat 的日志文件',
    '  --window normal|min|hidden   napcat start 的窗口样式（默认 min；hidden 要包装脚本）',
    '',
    '退出码：0 全部通过；1 有错误；2 需要人工 / 提权；3 脚本自身出错',
  ];
  say(lines.join('\n'));
}

async function main() {
  const [command, sub] = args.positionals;
  // `--help` 优先于「没给命令」：两者都打印用法，但一个是人主动问的（0），一个是用错了（3）。
  if (args.flags.has('help') || args.flags.has('h') || command === 'help') {
    printUsage();
    return 0;
  }
  if (command === undefined) {
    printUsage();
    return 3;
  }
  if (!OPS_COMMANDS.includes(command)) {
    return fail(String(command), minimalPlatform(), `不认识命令「${command}」。用 --help 看用法。`);
  }
  const platform = await detect();
  say(`平台：${describePlatform(platform)}`);
  switch (command) {
    case 'doctor':
      return await commandDoctor(platform);
    case 'status':
      return await commandStatus(platform);
    case 'restart':
      return await commandRestart(platform);
    case 'logs':
      return await commandLogs(platform);
    case 'install':
      return await commandInstall(platform);
    case 'uninstall':
      return await commandUninstall(platform);
    case 'napcat':
      return await commandNapcat(platform, sub);
    case 'migrate':
      return await commandMigrate(platform, sub);
    case 'cleanup':
      return await commandCleanup(platform, sub);
    case 'selftest':
      return await commandSelftest(platform);
    default:
      return fail(String(command), platform, `不认识命令「${command}」`);
  }
}

process.exitCode = await main();
