#!/usr/bin/env node
/**
 * Windows 桌面版的一键配置：把 **NapCat 那一侧** 和 **DSH 那一侧** 一次配好。
 *
 * 为什么需要它：这个插件要跑起来，机器上其实有**两个**软件要配 —— NapCat 里得有一条
 * 启用的 WebSocket 服务器（端口、token 与插件一致），DSH 那边得把插件装进 profile 并
 * 让数据目录落在写得进去的地方。任何一步没做，用户看到的现象都只是「机器人一句话都不说」，
 * 而线索分别在 NapCat 的 `config/onebot11_<QQ>.json`、profile 的 `package.json` 和 `.env` 里。
 * 这个脚本把那三处一起处理掉，并且每一步都是**幂等 + 先备份**的。
 *
 * 用法（在仓库根目录，或者双击 scripts/napcat-setup.cmd）：
 *
 *     node scripts/napcat-setup.mjs                  # 自动探测 + 配好 + 装进 desktop profile
 *     node scripts/napcat-setup.mjs --dry-run        # 只打印将要做什么，一个字都不写
 *     node scripts/napcat-setup.mjs --qq 123456      # 指定账号（还没登录过也能先写好配置）
 *     node scripts/napcat-setup.mjs --profile none   # 只配 NapCat 和 .env，不碰 profile
 *     node scripts/napcat-setup.mjs --start          # 顺手把 NapCat 启动起来（提权 + 快速登录）
 *     node scripts/napcat-setup.mjs --autostart install   # 装计划任务：以后开机静默启动、没有黑框框
 *     node scripts/napcat-setup.mjs --start --window hidden   # 就这一次不要那个控制台窗口
 *     node scripts/napcat-setup.mjs --where          # 只回答「用的是哪份 node」，什么都不写
 *
 * 参数：
 *   --napcat <目录>   NapCat 安装目录（默认探测：本仓库里的 NapCat.Shell 等；刚解压、
 *                     还没登录过的也算 —— 靠目录里 NapCat 自带的启动件认出它）
 *   --qq <号码>       账号；缺省取 config 目录里已有的那个。给了它就顺便把 NapCat 的
 *                     `autoLoginAccount` 设成它：以后启动自动快速登录，不用每次扫码
 *                     （不想要这条就加 --no-auto-login）
 *   --port <端口>     OneBot WebSocket 端口（默认 3001）
 *   --token <token>   access_token（默认空）
 *   --cwd <目录>      QQ 会话的工作目录（默认 ~/.dsh/qq-bot；写进 profile 的 .env）
 *   --profile <名字>  装进哪个 DSH profile（默认 desktop；none = 不动 profile）
 *   --no-install      等价于 --profile none
 *   --reset-users <号码,号码>  允许用 /reset 的人的 QQ 号（写进 .env 的 QQBOT_RESET_USERS；默认不写 = 谁都不能）
 *   --start           配置完成后启动 NapCat。**必须提权**：普通用户身份下注入其实成功，
 *                     但 QQ 随后会崩在 QQNT.dll（0x80000003），控制台只剩一句 Process exited.
 *   --window <样式>   normal / min / hidden，默认 min。首次登录要扫二维码，得能看见窗口。
 *                     `hidden` 走的是另一个机制（GUI 宿主的包装脚本），连「运行期间不能关掉
 *                     那个窗口」都不存在了；装了计划任务之后它还会顺手免掉 UAC
 *   --autostart <动作> install（默认）/ remove / status：注册一个计划任务，**登录时以管理员
 *                     身份、无窗口**启动 NapCat。装一次 UAC，以后启动都不再问；status 只查询。
 *                     装的时候会顺手把 NapCat 日志改成写文件（窗口看不见了，日志是唯一的现场），
 *                     不想要就加 --no-log-to-file
 *   --no-run-now      --autostart install 只装任务，不立即启动一次
 *   --no-auto-login   不写 `autoLoginAccount`（默认写：`--qq` 给了就设成它）
 *   --force           跳过「这份 NapCat 还没启动过、隐藏启动会让你看不见二维码」的拦阻
 *   --dry-run         只打印，不写任何文件
 *
 * 它**不修改插件的源码**，也不碰 `~/.dsh/.credentials.yaml`：模型凭据仍然在 DSH 的
 * Models 页面里填一次（或由启动环境提供）。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/napcat-setup
 */
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountFiles, desiredServer, findNapcatDir, hiddenWrapperVbs, HIDDEN_WRAPPER_NAME, repairNapcat, scheduledTaskDeletePlan, scheduledTaskInstallPlan, scheduledTaskQueryPlan, scheduledTaskRunPlan, scheduledTaskXml, startPlan, TASK_NAME, TASK_XML_NAME, webuiTarget, withAutoLoginAccount, withNapcatLogging, withWebsocketServer } from '../napcat.js';
import { applyEnvBlock, PLUGIN_NAME as pluginName, pluginLinkState, removePluginLink, withPluginInstalled } from '../desktop.js';
import { readTextOrUndefined, writeJsonAtomic, writeTextAtomicUtf16 } from '../filestore.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一条 `--key value` / `--flag` 的命令行。 */
function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  const takesValue = new Set(['napcat', 'qq', 'port', 'token', 'cwd', 'profile', 'reset-users', 'window', 'autostart']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const name = item.slice(2);
    if (takesValue.has(name)) {
      const next = argv[index + 1];
      // 后面那个不是值而是另一个开关时（`--autostart --dry-run`），别把它当成值吃掉：
      // 记成「只写了开关」——`--autostart` 单独出现就是它的默认动作 install。
      if (next === undefined || next.startsWith('--')) args.flags.add(name);
      else {
        args.values[name] = next;
        index += 1;
      }
      continue;
    }
    args.flags.add(name);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args.flags.has('dry-run');
const profileName = args.flags.has('no-install') ? 'none' : (args.values.profile ?? 'desktop');
const port = Number(args.values.port ?? 3001);
const token = args.values.token ?? '';
const endpoint = `ws://127.0.0.1:${port}`;

/**
 * `--where`：只回答「我这份 node 是从哪来的」。
 *
 * 为什么值得单独一个开关：`.cmd` 那条路会自己去找桌面版自带的 Node，而**用哪一份 node**
 * 直接决定「找不到模块」「版本太老」这类问题查起来要多久。排查时先问一句，比截图强。
 * 它一个字都不写盘，所以真跑和试运行没区别。
 */
if (args.flags.has('where')) {
  say(`node：${process.execPath}`);
  say(`版本：${process.version}（本插件要求 Node ≥ 22，见 package.json 的 engines）`);
  say(`这个脚本：${fileURLToPath(import.meta.url)}`);
  process.exit(0);
}

/** 统一的输出：每一行都带前缀，方便用户把「脚本说要做什么」和「它真的做了什么」对上。 */
function say(message) {
  process.stdout.write(`${dryRun ? '[试运行] ' : ''}${message}\n`);
}

/** 失败就用非零码退出：发布版里的安装器要能靠退出码判断这一步成没成。 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** 备份文件名里的时间戳：与 `napcat.js` 那个同形（能排序、又不会有冒号这种 Windows 非法字符）。 */
function backupStamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
}

/**
 * 跑一个计划（`napcat.js` 里那些纯函数算出来的 `{ command, args }`）。
 *
 * 两个刻意的选择：
 *   - **等待时 `stdio: 'inherit'`**：UAC 弹窗、`schtasks` 的报错都该原样给用户看见，
 *     而且这条路上我们**不读子进程的输出**（DSH 沙箱里捕获子进程输出会被拦成
 *     `spawn EPERM`）—— 需要的信息就是退出码。
 *   - **`detached` 时不等待**：启动 NapCat 是常驻进程，脚本说完就该退出，不占着它。
 *
 * @param plan - `{ command, args, describe }`（也可能是 `{ unsupported }`）。
 * @param options.detached - true = 发了就返回（常驻进程走这条）。
 * @returns 退出码；`detached` 与试运行时返回 0。
 */
async function runPlan(plan, { detached = false } = {}) {
  if (plan === undefined || plan.unsupported !== undefined) {
    say(`  → ${plan?.unsupported ?? '内部错误：没有可执行的计划'}`);
    return 1;
  }
  if (dryRun) {
    say(`  → 会${plan.describe}`);
    return 0;
  }
  const child = spawn(plan.command, plan.args, {
    detached,
    stdio: detached ? 'ignore' : 'inherit',
    windowsHide: detached,
  });
  if (detached) {
    child.unref();
    return 0;
  }
  return await new Promise((resolveCode) => {
    child.on('error', (error) => {
      say(`  → 起不来：${error?.message ?? error}`);
      resolveCode(1);
    });
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}

/**
 * 计划任务装过没有：只用退出码回答（`schtasks /query` 找不到时是非零）。
 * 刻意不打印任何东西 —— 调用方是拿它当判据的，不是给用户看的。
 */
async function taskExists(taskName) {
  if (dryRun) return false;
  const plan = scheduledTaskQueryPlan({ taskName });
  const child = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });
  return await new Promise((resolve) => {
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 计划任务里要写的 `域\用户名`：环境变量里就有，别为这个去问系统。 */
function currentUserId() {
  const user = String(process.env.USERNAME ?? '').trim();
  const domain = String(process.env.USERDOMAIN ?? '').trim();
  if (user.length === 0) return '';
  return domain.length > 0 ? `${domain}\\${user}` : user;
}

/**
 * 打印 WebUI 的地址与令牌。
 *
 * 为什么这件事跟「隐藏窗口」有关：窗口一藏，WebUI 就是用户唯一还看得见的东西
 * （看日志、扫码登录、改配置都在那儿），而它的令牌是 NapCat 随机生成、原本打在控制台里的。
 *
 * @param configDir - NapCat 的 `config` 目录。
 * @returns 打印出来了没有（`webui.json` 不存在或读不出来时 false）。
 */
async function sayWebuiHint(configDir) {
  const text = await readTextOrUndefined(join(configDir, 'webui.json'));
  if (text === undefined) return false;
  let target;
  try {
    target = webuiTarget(JSON.parse(text));
  } catch {
    target = undefined;
  }
  if (target === undefined) return false;
  say(`  → WebUI：${target.url}${target.token.length > 0 ? `（token：${target.token}）` : ''} —— 日志、扫码登录、改配置都在这里`);
  return true;
}

/**
 * 把 NapCat 的日志改成写文件（隐藏启动时默认做的事）。
 *
 * 只动 `consoleLog` / `fileLog` 两个字段、先备份、幂等 —— 与 NapCat 其它的写操作同一套规矩。
 *
 * @param napcatDir - NapCat 根目录。
 */
async function setFileLogging(napcatDir) {
  const file = join(napcatDir, 'config', 'napcat.json');
  const text = await readTextOrUndefined(file);
  if (text === undefined) {
    say(`  → 没有 ${file}（NapCat 启动过一次才会生成）：跳过日志设置`);
    return;
  }
  let current;
  try {
    current = JSON.parse(text);
  } catch (error) {
    say(`  → ${file} 不是合法 JSON（${error?.message ?? error}）：跳过日志设置，没动它`);
    return;
  }
  const patched = withNapcatLogging(current, { consoleLog: false, fileLog: true });
  if (!patched.changed) {
    say('  → 日志已经是「写文件」了，不动它');
    return;
  }
  if (dryRun) {
    say(`  → 会把日志改成写文件：${file} 的 consoleLog=false / fileLog=true`);
    return;
  }
  const backup = `${file}.bak-${backupStamp()}`;
  await copyFile(file, backup);
  await writeJsonAtomic(file, patched.config);
  say(`  → 已把日志改成写文件：看不见窗口时，现场在 ${join(napcatDir, 'logs')}（原文件备份在 ${backup}）`);
}

/**
 * 挑一个启动器：**首选官方文档让双击的那个**（`launcher.bat`，它会自己提权），
 * 没有才退回不提权的 `launcher-user.bat`。
 *
 * 为什么不直接写死 `launcher-user.bat`：那是「刻意不提权」的变体，而 Windows 上不提权
 * 会让 QQ 在注入后崩在 QQNT.dll（见 `napcat.js` 的 `startPlan`）。官方文档让用户双击的
 * 正是会提权的 `launcher.bat` —— 脚本跟着文档走。
 */
function pickLauncher(dir) {
  for (const name of ['launcher.bat', 'launcher-user.bat']) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return '';
}

/**
 * DSH 的家目录。与 DSH 自己的规则一致：先看 `DSH_HOME`，否则 `~/.dsh`。
 * 不猜别的位置 —— 装错了 profile 比不装更让人困惑。
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  return resolve(configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.dsh'));
}

/**
 * 幂等地维护 `.env` 里那一段（真正的文本处理在 `desktop.js` 的 `applyEnvBlock` 里，
 * 是个有单测的纯函数；这里只负责读写与「内容没变就不写盘」）。
 *
 * `.env` 是 DSH 启动时读的（`<启动 cwd>/.env`，桌面版那个 cwd 就是 profile 目录）。
 *
 * @param file - `.env` 的绝对路径。
 * @param values - 要写入的键值。
 * @returns 需不需要写盘。
 */
async function updateEnvBlock(file, values) {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const next = applyEnvBlock(existing, values);
  if (next === existing) return false;
  if (!dryRun) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next, 'utf8');
  }
  return true;
}

/**
 * 把插件装进一个 profile：`package.json`（dependencies + dsh.profile.bundles）指向本仓库，
 * 并在 profile 的 `node_modules` 里放一个指向仓库的链接。
 *
 * 为什么不直接调用 pnpm：桌面版自带 pnpm、也有插件管理界面（那条路更正规），但这条路
 * 不依赖网络、不看 registry、也不需要用户在 GUI 里点，适合「发布版一条命令搞定」。
 * 我们做的和 `pnpm add link:<路径>` 等价：manifest 一处 + node_modules 一个链接。
 * 代价写在输出里（下次在 GUI 里做插件操作时，pnpm 可能会把它规范化一遍）。
 *
 * @param directory - profile 目录（`~/.dsh/profiles/<名字>`）。
 * @returns 每一步的结果描述，交给调用方打印。
 */
async function installIntoProfile(directory) {
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, notes: [`${manifestPath} 不存在：这个 profile 还没被创建过。请先启动一次桌面版 DSH（它会建好 desktop profile），再跑这个脚本。`] };
  }
  const notes = [];
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // 「改哪些字段」是纯函数（desktop.js，有单测）；这里只负责读写与备份。
  const patched = withPluginInstalled(manifest, repoRoot);
  const changed = patched.changed;
  if (changed) {
    const backup = `${manifestPath}.bak-${backupStamp()}`;
    if (!dryRun) {
      await copyFile(manifestPath, backup);
      await writeJsonAtomic(manifestPath, patched.manifest);
    }
    notes.push(`profile 的 package.json ${dryRun ? '会更新' : '已更新'}（依赖 + bundles 两处一起；原文件备份在 ${backup}）`);
  } else {
    notes.push('profile 的 package.json 里已经有这个插件（依赖 + bundles 都在），不动它');
  }
  // node_modules 里的链接：Windows 上必须用 junction（符号链接要额外权限或开发者模式），
  // 恰好 junction 也是我们在沙箱里被拦下的那种操作，所以失败时给一条明确的退路。
  //
  // 这里**不能只看 `existsSync`**：链接早就存在、却指着别的目录（上一份发布包、旧的 clone、
  // 别的盘）是这套安装最常见的一种错装 —— manifest 那一行被改成了新路径，而解析走的其实是
  // 链接，于是「装的是新代码、跑的是旧代码」，一句报错都没有（DSH 只管能不能解析到这个包）。
  // 所以「存在」必须升级成「存在且指着本仓库」。
  const linkPath = join(directory, 'node_modules', ...pluginName.split('/'));
  const link = pluginLinkState(linkPath, repoRoot, { lstatSync, readlinkSync, realpathSync });
  if (link.state === 'linked') {
    notes.push(`链接已经是这个仓库：${linkPath}`);
  } else if (link.state === 'not-a-link') {
    // 那里有个**真的**文件/目录：可能是用户手工拷进来的插件。不删 —— 但必须说清
    // 「现在跑的是它、不是本仓库」，否则用户会以为这一步配好了。
    notes.push(`链接跳过：${linkPath} 已经存在且不是一个链接（可能是一份手工拷进去的插件）：删掉它再跑本脚本，否则加载的是它、不是 ${repoRoot}`);
  } else if (dryRun) {
    if (link.state === 'missing') notes.push(`会建立链接 ${linkPath} → ${repoRoot}`);
    else notes.push(`会重建链接：${linkPath} 现在指着 ${link.target ?? '一个读不出来的位置'}，要改成 ${repoRoot}`);
  } else {
    try {
      if (link.state === 'elsewhere' || link.state === 'unknown') {
        // 链接本身可以安全删掉（它就只是一条指向），先删再建 —— junction 不能就地改指向。
        // 删法是 desktop.js 里的纯函数（unlink 对 junction 是 EPERM，要退到 rmdir）。
        const removed = removePluginLink(linkPath, { unlinkSync, rmdirSync });
        if (!removed) {
          notes.push(`旧链接删不掉（${linkPath}）：请自己在桌面版的「设置 → 插件」里把它指向 ${repoRoot}，或删掉它之后重跑本脚本`);
          return { ok: true, notes };
        }
        notes.push(link.state === 'unknown'
          ? '原来那条链接已经读不出指向了（目标被删过？），已删掉它重建'
          : `原来指向 ${link.target}，已删掉那条旧链接`);
      }
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(repoRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      notes.push(`已建立链接 ${linkPath} → ${repoRoot}`);
    } catch (error) {
      notes.push(`建链接失败（${error?.message ?? error}）：请改用桌面版的「设置 → 插件」从本地路径安装，或在管理员/开发者模式下重跑`);
    }
  }
  return { ok: true, notes };
}

/** 找 NapCat 的安装目录：命令行 > 环境变量 > 几个常见位置。 */
async function locateNapcat() {
  const explicit = args.values.napcat ?? process.env.QQBOT_NAPCAT_DIR;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const dir = resolve(explicit.trim());
    if (!existsSync(dir)) fail(`--napcat 指的目录不存在：${dir}`);
    return { dir, explicit: true };
  }
  const candidates = [join(repoRoot, 'NapCat.Shell'), join(process.cwd(), 'NapCat.Shell'), join(homedir(), 'NapCat.Shell')];
  const found = await findNapcatDir(candidates);
  return { dir: found, explicit: false, candidates };
}

/**
 * 主流程。每一步都先打印「要做什么」，做完再说「成了什么」—— 试运行与真跑共用同一条代码路径，
 * 所以 `--dry-run` 的输出就是真的会发生的事。
 */
async function main() {
  say(`仓库：${repoRoot}`);
  say(`OneBot：${endpoint}${token.length > 0 ? '（带 token）' : ''}`);

  // ---- 1. NapCat 那一侧 ------------------------------------------------------
  const located = await locateNapcat();
  // 机器人自己的号：命令行给了就用它，否则取 config 里已有的那个。后面的「快速登录」
  // 与「先把骨架配置写好」要用同一个值，所以在这里定一次。
  let wantedQq = String(args.values.qq ?? '').trim();
  if (located.dir === undefined) {
    say('没找到 NapCat 安装目录（找过：' + located.candidates.join(' / ') + '）');
    say('  → 用 --napcat <目录> 指定，或者把 NapCat.Shell 解压到本仓库根目录下');
  } else {
    say(`NapCat：${located.dir}`);
    const configDir = join(located.dir, 'config');
    const names = existsSync(configDir) ? await readdir(configDir) : [];
    const accounts = accountFiles(names);
    if (wantedQq.length === 0) wantedQq = String(accounts[0]?.qq ?? '');
    if (accounts.length === 0 && wantedQq.length === 0) {
      say('  → 这个 NapCat 还没登录过任何账号（config 里没有 onebot11_<QQ号>.json）');
      say('  → 先用 --qq <号码> 跑一次，登录之后再跑一次即可（脚本会把配置写好／对齐）');
    } else if (accounts.length === 0) {
      // 还没登录过，但用户告诉了我们 QQ 号：先把一份最小配置写好。NapCat 登录后会用它。
      const file = join(configDir, `onebot11_${wantedQq}.json`);
      const skeleton = withWebsocketServer({ network: { websocketServers: [] } }, desiredServer({ port, token })).config;
      say(`  → 还没有 ${wantedQq} 的配置文件，先写一份最小的：${file}`);
      if (!dryRun) {
        await mkdir(configDir, { recursive: true });
        await writeJsonAtomic(file, skeleton);
      }
      say('  → 注意：NapCat 首次登录时可能会自己重写这个文件，那时重新跑一次本脚本');
    } else {
      const result = await repairNapcat({
        dir: configDir,
        endpoint,
        token,
        qq: args.values.qq ?? '',
        autoConfig: !dryRun,
      });
      if (result.action === 'ok') say(`  → 已经是配好的：${result.file}`);
      else if (result.action === 'repaired') say(`  → ${result.reason}；已写进 ${result.file}（原文件备份在 ${result.backup}）`);
      else if (result.action === 'needs-repair') say(`  → 需要修：${result.reason}（试运行不写盘）`);
      else say(`  → 没配成：${result.reason}`);
    }

    // 快速登录：把 `autoLoginAccount` 写进 NapCat 的 WebUI 配置（只在用户明确给了 --qq 时）。
    // 为什么只认显式 `--qq`：一个 NapCat 可能配了多个账号，悄悄替用户挑一个登录太自作主张。
    if (args.values.qq !== undefined && !args.flags.has('no-auto-login')) {
      const webuiFile = join(configDir, 'webui.json');
      const text = await readTextOrUndefined(webuiFile);
      if (text === undefined) {
        // 刻意**不**凭空造这个文件：它是 NapCat 的 WebUI 配置（host / port / token 等一堆字段），
        // 我们写一份只剩下 autoLoginAccount 的，等于把它的 WebUI 配置抹掉。
        say(`  → 还没有 ${webuiFile}（NapCat 启动过一次才会生成）—— 想让它以后自动快速登录，登录之后再跑一次本脚本`);
      } else {
        let current;
        try {
          current = JSON.parse(text);
        } catch (error) {
          current = undefined;
          say(`  → ${webuiFile} 不是合法 JSON（${error?.message ?? error}）：跳过自动快速登录，没动它`);
        }
        if (current !== undefined) {
          const auto = withAutoLoginAccount(current, wantedQq);
          if (!auto.changed) {
            say(`  → webui.json 里已经是自动快速登录 ${wantedQq}，不动它`);
          } else if (dryRun) {
            say(`  → 会设置自动快速登录：${webuiFile} 的 autoLoginAccount = ${wantedQq}`);
          } else {
            const backup = `${webuiFile}.bak-${backupStamp()}`;
            await copyFile(webuiFile, backup);
            await writeJsonAtomic(webuiFile, auto.config);
            say(`  → 已设置自动快速登录 autoLoginAccount = ${wantedQq}：以后启动不用扫码（原文件备份在 ${backup}）`);
          }
        }
      }
    }
  }

  // ---- 2. .env（DSH 启动时读，用于按机器不同的取值）--------------------------
  const cwd = resolve(args.values.cwd ?? join(dshHome(), 'qq-bot'));
  if (profileName === 'none') {
    say('--profile none：不写 .env、不动任何 profile');
  } else {
    const directory = join(dshHome(), 'profiles', profileName);
    say(`DSH profile：${directory}`);
    const envFile = join(directory, '.env');
    const values = {
      // 插件的 bundle patch 里这些字段写的是 `!!js process.env.QQBOT_*`，所以这里写的就是
      // 「这台机器上的取值」；留空的那几个保持留空 = 用插件自己的平台默认值。
      QQBOT_ENDPOINT: endpoint,
      QQBOT_ACCESS_TOKEN: token,
      QQBOT_CWD: cwd,
      ...(located.dir === undefined ? {} : { QQBOT_NAPCAT_DIR: located.dir }),
      // 刻意**不**把 `--qq`（NapCat 登录的那个号 = 机器人自己）写进 resetUsers：
      // 那一项是「允许重置会话的**人**」，写进机器人自己的号等于没给别人权限，
      // 还容易让人以为配好了。要放开就显式给 --reset-users。
      ...(args.values['reset-users'] === undefined ? {} : { QQBOT_RESET_USERS: String(args.values['reset-users']) }),
    };
    const wrote = await updateEnvBlock(envFile, values);
    say(wrote ? `  → .env ${dryRun ? '会更新' : '已更新'}：${envFile}` : `  → .env 已经是最新的：${envFile}`);
    say('  （.env 只在 DSH 启动时读一次：改完必须重启 DSH 才生效）');

    // ---- 3. 装进 profile ------------------------------------------------------
    const installed = await installIntoProfile(directory);
    for (const note of installed.notes) say(`  → ${note}`);
    if (!installed.ok) process.exitCode = 2;
  }

  // ---- 4. 计划任务：登录时以管理员身份、无窗口启动（--autostart）--------------
  // 这一步解决的是「那个黑框框 + 每次启动都要点 UAC」这对组合：注册一次计划任务，
  // 以后 `schtasks /run` 以最高权限静默拉起 NapCat，窗口从头到尾不存在。
  const autostartMode = String(args.values.autostart ?? (args.flags.has('autostart') ? 'install' : '')).trim().toLowerCase();
  let startedAlready = false;
  if (autostartMode !== '') {
    if (!['install', 'remove', 'status'].includes(autostartMode)) {
      fail(`--autostart 只认 install / remove / status（拿到的是 ${autostartMode}）`);
    }
    if (autostartMode === 'remove') {
      const code = await runPlan(scheduledTaskDeletePlan({ taskName: TASK_NAME }));
      if (code === 0) say(`  → 计划任务「${TASK_NAME}」已删除（NapCat 本身没被停掉）`);
      else process.exitCode = 1;
    } else if (autostartMode === 'status') {
      if (!(await taskExists(TASK_NAME))) {
        say(`  → 没有装过计划任务「${TASK_NAME}」（装它：--autostart install）`);
      } else {
        say(`  → 计划任务「${TASK_NAME}」在：`);
        await runPlan(scheduledTaskQueryPlan({ taskName: TASK_NAME, verbose: true }));
      }
    } else if (located.dir === undefined) {
      say('--autostart install：没找到 NapCat 目录，先解压一份或用 --napcat <目录> 指定');
      process.exitCode = 2;
    } else {
      const launcher = pickLauncher(located.dir);
      const configDir = join(located.dir, 'config');
      if (launcher.length === 0) {
        say(`--autostart install：${located.dir} 里找不到 launcher.bat / launcher-user.bat`);
        process.exitCode = 2;
      } else if (!existsSync(join(configDir, 'webui.json')) && !args.flags.has('force')) {
        // 隐藏启动的前提是「出得来二维码」。`webui.json` 是 NapCat 第一次启动时生成的，
        // 连它都没有 = 这份 NapCat 从没启动过：那时候隐藏启动会让人连二维码都看不见，
        // WebUI 也打不开，等于把自己关在门外。所以拦住，并给出唯一的出路。
        say(`  → 这份 NapCat 还没启动过（没有 ${join(configDir, 'webui.json')}）：隐藏启动会让你连二维码都看不见`);
        say('  → 先跑一次 `--start --window normal` 扫码登录，再回来装计划任务');
        say('  → 确定知道自己在做什么就加 --force');
        process.exitCode = 2;
      } else {
        const wrapper = join(located.dir, HIDDEN_WRAPPER_NAME);
        const xmlFile = join(located.dir, TASK_XML_NAME);
        const vbs = hiddenWrapperVbs({ launcher, qq: wantedQq, napcatDir: located.dir });
        if (dryRun) {
          say(`  → 会写包装脚本 ${wrapper}（用 wscript 以隐藏窗口启动 NapCat${wantedQq.length > 0 ? `，快速登录 ${wantedQq}` : ''}）`);
        } else {
          await writeTextAtomicUtf16(wrapper, vbs);
          say(`  → 已写包装脚本 ${wrapper}`);
        }
        // 窗口看不见了，日志就是唯一的现场：顺手把它改成写文件（--no-log-to-file 可关）。
        if (args.flags.has('no-log-to-file')) say('  → --no-log-to-file：不动 NapCat 的日志设置（隐藏启动后就没有现场可看了）');
        else await setFileLogging(located.dir);
        const xml = scheduledTaskXml({ taskName: TASK_NAME, wrapper, napcatDir: located.dir, userId: currentUserId() });
        if (xml === undefined) {
          say('  → 算不出计划任务 XML：拿不到当前用户名（USERDOMAIN / USERNAME 环境变量），计划任务里必须写明它');
          process.exitCode = 1;
        } else {
          if (dryRun) {
            say(`  → 会写计划任务 XML ${xmlFile}（登录时触发、以最高权限、任务名 ${TASK_NAME}）`);
          } else {
            await writeTextAtomicUtf16(xmlFile, xml);
            say(`  → 已写计划任务 XML ${xmlFile}`);
          }
          const code = await runPlan(scheduledTaskInstallPlan({ taskName: TASK_NAME, xmlPath: xmlFile }));
          if (code !== 0) {
            say('  → 注册没成（UAC 被取消？）—— 也可以自己跑：schtasks /create /tn ' + TASK_NAME + ' /xml "' + xmlFile + '" /f');
            process.exitCode = 1;
          } else if (args.flags.has('no-run-now')) {
            say(`  → 已装好；要现在启动就跑 schtasks /run /tn ${TASK_NAME}`);
          } else if ((await runPlan(scheduledTaskRunPlan({ taskName: TASK_NAME }))) === 0) {
            startedAlready = true;
            say('  → 已通过计划任务启动（以管理员身份、无窗口、也没问 UAC）');
          }
        }
      }
    }
    // 装了 / 查过之后都把 WebUI 的位置说清楚 —— 它是没有窗口时唯一的「控制台」。
    if (located.dir !== undefined) await sayWebuiHint(join(located.dir, 'config'));
  }

  // ---- 5. 启动 NapCat（可选）------------------------------------------------
  if (args.flags.has('start') && !startedAlready) {
    if (located.dir === undefined) {
      say('--start：没有 NapCat 目录，跳过');
    } else {
      // 「怎么启动」是 `napcat.js` 里的纯函数（有单测）：提权、窗口样式、快速登录参数
      // 都在那里，这里只负责挑启动器、按需写包装脚本、真的 spawn、把结果说清楚。
      const launcher = pickLauncher(located.dir);
      const windowMode = String(args.values.window ?? 'min').trim();
      if (windowMode === 'hidden' && (await taskExists(TASK_NAME))) {
        // 装过计划任务就走它：不提权、不弹 UAC、也没有窗口 —— 这是隐藏启动的正路。
        say(`  → 计划任务「${TASK_NAME}」已经装过：走它启动（不提权、不弹 UAC、也没有窗口）`);
        if ((await runPlan(scheduledTaskRunPlan({ taskName: TASK_NAME }))) !== 0) {
          say(`  → 任务没启动起来：用 --autostart status 看它怎么了`);
        }
      } else {
        let wrapper = '';
        if (windowMode === 'hidden' && launcher.length > 0) {
          // 隐藏启动要一份包装脚本：按需生成（内容固定，重跑就覆盖同一份）。
          wrapper = join(located.dir, HIDDEN_WRAPPER_NAME);
          if (dryRun) {
            say(`  → 会写包装脚本 ${wrapper}`);
          } else {
            await writeTextAtomicUtf16(wrapper, hiddenWrapperVbs({ launcher, qq: wantedQq, napcatDir: located.dir }));
            say(`  → 已写包装脚本 ${wrapper}`);
          }
        }
        const plan = startPlan({ launcher, qq: wantedQq, windowMode, wrapper });
        if (plan.unsupported !== undefined) {
          say(`--start：${plan.unsupported}`);
        } else {
          await runPlan(plan, { detached: true });
          if (!dryRun) say(`${plan.describe} —— 已发出启动${windowMode === 'hidden' ? '（UAC 弹窗点「是」；这次之后就装计划任务吧）' : '（UAC 弹窗点「是」）'}`);
        }
      }
    }
  }

  // ---- 6. 收尾：告诉用户还差哪一步 -------------------------------------------
  say('');
  say('接下来：');
  if (!args.flags.has('start') && !startedAlready && located.dir !== undefined) {
    const launcher = pickLauncher(located.dir) || join(located.dir, 'launcher.bat');
    say(`  1) 启动 NapCat：双击 ${launcher}（会弹 UAC，点「是」；首次要扫码登录）`);
  }
  if (profileName !== 'none') say('  2) 重启 DSH 桌面版 —— 插件源码在启动时加载，装完必须重启');
  say('  3) 在 DSH 的 Models 页面确认模型凭据已填（插件不碰凭据文件）');
  say('  4) 私聊机器人发一句话：它在 QQ 里回你，就说明整条链路通了');
  if (located.dir !== undefined) {
    say(`  （那个控制台窗口就是 NapCat 本体：关掉它 = 停掉机器人。不想看见它就跑 --autostart install：`);
    say(`    登录时以管理员身份、无窗口启动，以后也不再问 UAC；停止用 schtasks /end /tn ${TASK_NAME}）`);
    await sayWebuiHint(join(located.dir, 'config'));
  }
  if (dryRun) say('（这是试运行：上面所有「已写」都只是打算做的事，去掉 --dry-run 才真的写）');
}

await main();
