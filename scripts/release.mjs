#!/usr/bin/env node
/**
 * scripts/release.mjs —— 打一份「给朋友下载」的发布包。
 *
 *   node scripts/release.mjs                    # 版本号取 package.json，NapCat 自动探测
 *   node scripts/release.mjs --dry-run          # 只说它打算做什么，一个字都不写
 *   node scripts/release.mjs --napcat <目录>    # 指定 NapCat.Shell 的位置
 *   node scripts/release.mjs --no-napcat        # 只打源码（几百 KB，不带上 NapCat）
 *   node scripts/release.mjs --keep-stage       # 留 dist/stage 便于排查
 *
 * 产出：`dist/dsh-qq-bridge-<版本>.zip`，里面是**一个顶层目录** —— 解压出来就是一个
 * 可以直接用的仓库副本（NapCat.Shell 也在里面，Windows 上双击 scripts\napcat-setup.cmd
 * 就能配）。
 *
 * 为什么要有这个脚本，而不是几条手敲的命令：
 *
 *   1. **发布包里最危险的东西是 NapCat 的运行态**。NapCat 把「这台机器上的哪个账号」
 *      落在 `config/` 里：`onebot11_<QQ号>.json` 连文件名都是 QQ 号，`webui.json` 里有
 *      WebUI token，`guild1.db` 是登录态。GitHub Release 的附件谁都能下，发出去就收不
 *      回来。所以「排除什么」写进代码，而不是靠人每次记得；而且打包**之后**还会再扫一遍
 *      暂存树，命中任何一条就整体失败。
 *   2. **`git archive` 保证包里只有被 git 跟踪的文件**：`data/`、`.env`、`node_modules`、
 *      日志、你自己的表情包与长期记忆天然进不来 —— 它们都是运行时产物，不该跟着发布走。
 *
 * 这个脚本**不碰网络、不动 git 的历史**：它只读（git archive 读的是已有的 tag）。
 * 推送与在 GitHub 上建 Release 是下一步的事，脚本会把命令打出来。
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** NapCat 里属于「这台机器的运行态」的目录，一个都不进发布包。 */
const EXCLUDED_DIRS = new Set(['config', 'logs', 'cache']);
/** 同上，按后缀排除：`guild1.db` 及它的 WAL 兄弟是 QQ 的会话库。 */
const EXCLUDED_SUFFIX = ['.db', '.db-shm', '.db-wal'];
/**
 * 打包之后再扫一遍暂存树用的黑名单。上面那份排除列表将来被改错（比如有人把 config
 * 从 EXCLUDED_DIRS 里删掉），这里会拦住，而不是等它出现在 GitHub 上。
 * 只按**文件名**判：NapCat 的配置文件就叫这几个名字，误伤不了别的。
 */
const FORBIDDEN_NAMES = [
  /^(onebot11|napcat|napcat_protocol)(_\d+)?\.json$/i,
  /^webui\.json$/i,
  /\.db(-shm|-wal)?$/i,
];

/** 打日志（这个脚本要能被人盯着看，所以直接写 stdout，不走 ctx.logger）。 */
function say(message = '') {
  process.stdout.write(`${message}\n`);
}

/** 出错就整体退出：发布包宁可不打，也不能打出一个带账号信息的。 */
function die(message) {
  process.stderr.write(`\n✖ ${message}\n`);
  process.exit(1);
}

/**
 * 解析命令行。只认这几个开关，别的参数直接报错 —— 打发布包这件事不该有隐藏行为。
 */
function parseArgs(argv) {
  const options = { dryRun: false, keepStage: false, withNapcat: true, napcat: '', version: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep-stage') options.keepStage = true;
    else if (arg === '--no-napcat') options.withNapcat = false;
    else if (arg === '--napcat') options.napcat = argv[++i] ?? '';
    else if (arg === '--version') options.version = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      say('用法：node scripts/release.mjs [--dry-run] [--no-napcat] [--napcat <目录>] [--keep-stage] [--version x.y.z]');
      process.exit(0);
    } else die(`不认识的参数：${arg}（--help 看用法）`);
  }
  return options;
}

/**
 * 跑一个子进程，**不捕获它的输出**（`stdio: 'ignore'`）。
 *
 * 两个理由：一是 tar/git 的进度对我们没用；二是捕获输出要用管道，而 DSH 的沙箱里
 * 进程间管道是被封的（会变成 `spawn EPERM`），发布脚本得能在沙箱里跑。
 */
function run(command, args, { cwd = repoRoot, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'ignore' });
  if (result.error) {
    if (allowFailure) return false;
    die(`起不了 ${command}：${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    die(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）`);
  }
  return result.status === 0;
}

/** 一个路径是不是「运行态」：命中就整个跳过（目录连子树一起）。 */
function isExcluded(fullPath, name) {
  if (EXCLUDED_DIRS.has(name.toLowerCase())) return true;
  const lower = name.toLowerCase();
  return EXCLUDED_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

/** 递归走一遍目录，把相对路径交出去（只给需要的地方用，别在发布脚本里做大动作）。 */
async function walk(dir, onFile, baseDir = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 读不到就当空目录：NapCat 包里偶尔有空的 cache/，不值得为此失败
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, onFile, baseDir);
    else if (entry.isFile()) await onFile(full, relative(baseDir, full).split(sep).join('/'));
  }
}

/** 「像 NapCat 安装目录」= 有 launcher 或者有 config 目录，用来在几个候选里挑一个。 */
function looksLikeNapcat(dir) {
  return Boolean(dir)
    && existsSync(dir)
    && (existsSync(join(dir, 'launcher-user.bat')) || existsSync(join(dir, 'config')) || existsSync(join(dir, 'napcat.mjs')));
}

/**
 * 找一个 NapCat 安装目录。顺序照着 README「目录、配置与文件都在哪」写：
 * 命令行给的 > 仓库根目录下的 > 上一级目录下的。找不到就明确报错，别猜。
 */
function findNapcat(explicit) {
  if (explicit) {
    const dir = resolve(explicit);
    if (!looksLikeNapcat(dir)) die(`--napcat ${dir} 看着不像 NapCat 安装目录（既没有 launcher-user.bat，也没有 config/ 或 napcat.mjs）`);
    return dir;
  }
  const candidates = [join(repoRoot, 'NapCat.Shell'), join(dirname(repoRoot), 'NapCat.Shell')];
  for (const candidate of candidates) if (looksLikeNapcat(candidate)) return candidate;
  die(`没找到 NapCat 安装目录。用 --napcat <目录> 指过去，或者加 --no-napcat 只打源码。\n  找过：${candidates.join('、')}`);
}

/**
 * 把 `<stage>/<name>` 压成 zip（参数全用相对路径，免得踩 Windows 盘符的坑）。
 *
 * 先试 `tar -a`：Windows 10 起自带的 bsdtar 支持按后缀自动选格式。GNU tar 不认 zip，
 * 所以失败就退回 `zip` 命令（Linux）。**不靠 `tar --version` 的输出来判断** —— 沙箱里
 * 管道被封、读不到子进程输出，直接"试一次"更诚实也更可移植。
 *
 * @returns 实际用上的工具名。
 */
async function makeZip(stageDir, name, outFile) {
  if (run('tar', ['-a', '-c', '-f', `../${outFile}`, name], { cwd: stageDir, allowFailure: true })) {
    if (await isZipFile(join(dirname(stageDir), outFile))) return 'tar';
    // tar 认了这个后缀却没真造出 zip（GNU tar 可能吐一个没压缩的 tar）——不能就这么交出去
    say('  … tar 造出来的不是 zip，改用 zip 命令');
  }
  await rm(join(dirname(stageDir), outFile), { force: true });
  if (run('zip', ['-r', '-q', `../${outFile}`, name], { cwd: stageDir, allowFailure: true })) {
    if (await isZipFile(join(dirname(stageDir), outFile))) return 'zip';
  }
  die(`打包 ${outFile} 失败：既没有能造 zip 的 tar（bsdtar），也没有 zip 命令。\n  Windows 10 起自带的 tar 就够用；Linux 上装 zip。`);
}

/** 只看头四个字节：ZIP 是 `PK\x03\x04`。用来防「tar 假装造了个 zip」。 */
async function isZipFile(file) {
  if (!existsSync(file)) return false;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } finally {
    await handle.close();
  }
}

/** 暂存树体检：黑名单 + 统计。返回文件数与命中黑名单的相对路径。 */
async function inspectTree(rootDir) {
  let files = 0;
  const offenders = [];
  await walk(rootDir, async (full, rel) => {
    files += 1;
    const name = rel.split('/').pop();
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) offenders.push(rel);
  });
  return { files, offenders };
}

const options = parseArgs(process.argv.slice(2));

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const version = options.version || pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`版本号 ${version} 不像 x.y.z`);
if (options.version && options.version !== pkg.version) {
  die(`--version ${options.version} 与 package.json 里的 ${pkg.version} 不一致。先改 package.json 再打，否则包里那行版本号会说谎。`);
}
const tag = `v${version}`;
const rootName = `dsh-qq-bridge-${version}`;
const distDir = join(repoRoot, 'dist');
const stageDir = join(distDir, 'stage');
const stageRoot = join(stageDir, rootName);
const tarFile = `${rootName}.tar`;
const zipFile = `${rootName}.zip`;

const napcatDir = options.withNapcat ? findNapcat(options.napcat) : '';
say(`版本      ${version}   （tag ${tag}）`);
say(`NapCat    ${napcatDir || '不打进包（--no-napcat）'}`);
say(`产出      dist/${zipFile}`);
say();

if (options.dryRun) {
  say('— dry-run：下面这些会被排除，然后什么都不写 —');
  if (napcatDir) {
    const entries = await readdir(napcatDir, { withFileTypes: true });
    const skipped = entries.filter((entry) => isExcluded(join(napcatDir, entry.name), entry.name));
    const dirs = skipped.filter((entry) => entry.isDirectory()).length;
    say(`  ${napcatDir}`);
    say(`  排除顶层条目 ${skipped.length} 个（目录 ${dirs} / 文件 ${skipped.length - dirs}）：`);
    for (const entry of skipped) say(`    - ${entry.name}`);
    const total = await inspectTree(napcatDir);
    say(`  NapCat 现有文件 ${total.files} 个；其中命中黑名单的 ${total.offenders.length} 处会被排除`);
    for (const rel of total.offenders.slice(0, 20)) say(`    ! ${rel}`);
  }
  say('\n真跑的话：从 tag 里 git archive 出源码树 → 拷一份干净的 NapCat → 压成一个 zip。');
  process.exit(0);
}

// ---- 打 ----

// tag 必须已经存在 —— 发布包应当**恰好**是那个 tag 的内容，而不是「此刻的工作区」。
// 这条检查放在 dry-run 之后：预演是只读的，没必要先有 tag 才能看它会排除什么。
if (!run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { allowFailure: true })) {
  die(`没有 ${tag} 这个 tag。先提交并打标签：\n    git add -A && git commit -m "release: ${tag}"\n    git tag -a ${tag} -m "dsh-qq-bridge ${tag}"\n  然后重新跑这个脚本。`);
}
// 工作区与 HEAD 不一致时提醒一句：包是按 tag 打的，没提交的改动**不会**进去。
// 用 `git diff --quiet` 而不是 `git status` —— 前者的结论在退出码里，不用读子进程输出。
if (!run('git', ['diff', '--quiet', 'HEAD'], { allowFailure: true })) {
  say('! 工作区有未提交的改动：发布包按 tag 打，这些改动不会进去。');
  say();
}

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

// git archive 只吐被跟踪的文件：运行时的 data/、.env、node_modules 天然不在里面。
// 用 tar 而不是 zip 中转，是因为 GNU tar 解不开 zip（Linux 上也能跑这套）。
//
// ⚠️ `git archive` **必须从仓库根跑**：它会把「当前目录」当成归档范围，在 `dist/` 里跑
// 就只打出一个 10240 字节的空 tar（`dist/` 自己还被 gitignore 挡着），退出码照样是 0。
// 这一条踩过：包打出来了、大小也像模像样，里面却没有插件本体。
const tarPath = join(distDir, tarFile);
say('· git archive 出源码树 …');
run('git', ['archive', '--format=tar', '-o', tarPath, tag], { cwd: repoRoot });
run('tar', ['-x', '-f', tarPath, '-C', stageRoot], { cwd: repoRoot });
await rm(tarPath, { force: true });

if (napcatDir) {
  say('· 拷一份干净的 NapCat …');
  const target = join(stageRoot, 'NapCat.Shell');
  await cp(napcatDir, target, {
    recursive: true,
    filter: (src) => !isExcluded(src, src.split(sep).pop()),
  });
}

/** 体检不过就整体放弃：删掉暂存树（不留下半成品），然后把原因说清楚。 */
async function abortBuild(message) {
  await rm(stageRoot, { recursive: true, force: true });
  die(message);
}

say('· 体检暂存树 …');

// 先点名检查「插件本体在不在」。这不是洁癖：`git archive` 在子目录里跑会打出一个空包，
// 而空包照样能压成 zip、大小也像模像样 —— 只有点名核对才拦得住。
const REQUIRED_FILES = ['index.js', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml', 'onebot.js'];
const missing = REQUIRED_FILES.filter((name) => !existsSync(join(stageRoot, name)));
if (missing.length) {
  await abortBuild(`暂存树里缺了插件本体：${missing.join('、')}。\n发布包**没有**生成。多半是 git archive 那一步没打出东西（它必须从仓库根跑）。`);
}
const stagedPkg = JSON.parse(await readFile(join(stageRoot, 'package.json'), 'utf8'));
if (stagedPkg.version !== version) {
  await abortBuild(`包里那份 package.json 写着 ${stagedPkg.version}，与 ${version} 不一致 —— 打错 tag 了？`);
}
if (napcatDir && !existsSync(join(stageRoot, 'NapCat.Shell', 'napcat.mjs'))) {
  await abortBuild('说了要带 NapCat，但暂存树里没有 NapCat.Shell/napcat.mjs。');
}

const report = await inspectTree(stageRoot);
if (report.offenders.length) {
  await abortBuild(`暂存树里出现了 ${report.offenders.length} 个不该发布的文件（NapCat 的账号配置 / 登录态）：\n  ${report.offenders.slice(0, 20).join('\n  ')}\n发布包**没有**生成。检查 EXCLUDED_DIRS 与 EXCLUDED_SUFFIX。`);
}

say('· 压 zip …');
await rm(join(distDir, zipFile), { force: true });
const tool = await makeZip(stageDir, rootName, zipFile);

const zipStat = await stat(join(distDir, zipFile));
if (!options.keepStage) await rm(stageDir, { recursive: true, force: true });

say();
say(`✓ dist/${zipFile}   ${report.files} 个文件 · ${(zipStat.size / 1024 / 1024).toFixed(1)} MB（压缩后）· 用的是 ${tool}`);
say();
say('下一步（脚本不碰网络、不动 git 历史）：');
say(`  git push origin main --follow-tags          # 或只推 tag：git push origin ${tag}`);
say('  然后到 GitHub 的 Releases 页 → Draft a new release → 选上面这个 tag');
say(`  → 标题填 dsh-qq-bridge ${tag} → 说明从 CHANGELOG.md 里粘对应那一节 → 上传 dist/${zipFile}`);
say('  （装了 gh 的话一条命令够：gh release create ' + tag + ` dist/${zipFile} --title "dsh-qq-bridge ${tag}" --notes-file CHANGELOG.md）`);
