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
 *     node scripts/napcat-setup.mjs --start          # 顺手把 NapCat 启动起来
 *
 * 参数：
 *   --napcat <目录>   NapCat 安装目录（默认探测：本仓库里的 NapCat.Shell 等）
 *   --qq <号码>       账号；缺省取 config 目录里已有的那个
 *   --port <端口>     OneBot WebSocket 端口（默认 3001）
 *   --token <token>   access_token（默认空）
 *   --cwd <目录>      QQ 会话的工作目录（默认 ~/.dsh/qq-bot；写进 profile 的 .env）
 *   --profile <名字>  装进哪个 DSH profile（默认 desktop；none = 不动 profile）
 *   --no-install      等价于 --profile none
 *   --reset-users <号码,号码>  允许用 /reset 的人的 QQ 号（写进 .env 的 QQBOT_RESET_USERS；默认不写 = 谁都不能）
 *   --start           配置完成后启动 NapCat（Windows 上走 launcher-user.bat）
 *   --dry-run         只打印，不写任何文件
 *
 * 它**不修改插件的源码**，也不碰 `~/.dsh/.credentials.yaml`：模型凭据仍然在 DSH 的
 * Models 页面里填一次（或由启动环境提供）。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/napcat-setup
 */
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountFiles, desiredServer, findNapcatDir, repairNapcat, withWebsocketServer } from '../napcat.js';
import { applyEnvBlock, PLUGIN_NAME as pluginName, withPluginInstalled } from '../desktop.js';
import { writeJsonAtomic } from '../filestore.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一条 `--key value` / `--flag` 的命令行。 */
function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  const takesValue = new Set(['napcat', 'qq', 'port', 'token', 'cwd', 'profile', 'reset-users']);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const name = item.slice(2);
    if (takesValue.has(name)) {
      args.values[name] = argv[index + 1];
      index += 1;
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

/** 统一的输出：每一行都带前缀，方便用户把「脚本说要做什么」和「它真的做了什么」对上。 */
function say(message) {
  process.stdout.write(`${dryRun ? '[试运行] ' : ''}${message}\n`);
}

/** 失败就用非零码退出：发布版里的安装器要能靠退出码判断这一步成没成。 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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
    const backup = `${manifestPath}.bak-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
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
  const linkPath = join(directory, 'node_modules', ...pluginName.split('/'));
  if (existsSync(linkPath)) {
    notes.push(`链接已存在：${linkPath}`);
  } else if (!dryRun) {
    await mkdir(dirname(linkPath), { recursive: true });
    try {
      await symlink(repoRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      notes.push(`已建立链接 ${linkPath} → ${repoRoot}`);
    } catch (error) {
      notes.push(`建链接失败（${error?.message ?? error}）：请改用桌面版的「设置 → 插件」从本地路径安装，或在管理员/开发者模式下重跑`);
    }
  } else {
    notes.push(`会建立链接 ${linkPath} → ${repoRoot}`);
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
  if (located.dir === undefined) {
    say('没找到 NapCat 安装目录（找过：' + located.candidates.join(' / ') + '）');
    say('  → 用 --napcat <目录> 指定，或者把 NapCat.Shell 解压到本仓库根目录下');
  } else {
    say(`NapCat：${located.dir}`);
    const configDir = join(located.dir, 'config');
    const names = existsSync(configDir) ? await readdir(configDir) : [];
    const accounts = accountFiles(names);
    const wantedQq = args.values.qq ?? accounts[0]?.qq;
    if (accounts.length === 0 && wantedQq === undefined) {
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

  // ---- 4. 启动 NapCat（可选）------------------------------------------------
  if (args.flags.has('start')) {
    if (located.dir === undefined) {
      say('--start：没有 NapCat 目录，跳过');
    } else if (process.platform !== 'win32') {
      say('--start 只在 Windows 上直接启动 NapCat；其它平台请按 README 的方式启动（容器里跑 NapCat 的那套）');
    } else {
      const launcher = join(located.dir, 'launcher-user.bat');
      if (!existsSync(launcher)) {
        say(`--start：找不到 ${launcher}`);
      } else if (dryRun) {
        say(`会启动：${launcher}`);
      } else {
        // `cmd /c start "" <bat>`：开一个**新窗口**跑 launcher（NapCat 的登录二维码、
        // 日志都在那个窗口里，用户需要看得见）。detached + ignore 让本脚本立刻退出。
        spawn('cmd.exe', ['/c', 'start', '', launcher], { cwd: located.dir, detached: true, stdio: 'ignore' }).unref();
        say(`已启动 NapCat：${launcher}（那个窗口里扫码登录）`);
      }
    }
  }

  // ---- 5. 收尾：告诉用户还差哪一步 -------------------------------------------
  say('');
  say('接下来：');
  if (!args.flags.has('start') && located.dir !== undefined) say('  1) 启动 NapCat：双击 NapCat.Shell\\launcher-user.bat（首次要扫码登录）');
  if (profileName !== 'none') say('  2) 重启 DSH 桌面版 —— 插件源码在启动时加载，装完必须重启');
  say('  3) 在 DSH 的 Models 页面确认模型凭据已填（插件不碰凭据文件）');
  say('  4) 私聊机器人发一句话：它在 QQ 里回你，就说明整条链路通了');
  if (dryRun) say('（这是试运行：上面所有「已写」都只是打算做的事，去掉 --dry-run 才真的写）');
}

await main();
