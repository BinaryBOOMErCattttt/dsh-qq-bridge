#!/usr/bin/env node
/**
 * 给这个仓库铺一个能在 **Windows 上真的跑起来**的 `node_modules`。
 *
 * 为什么需要它：`README` / `AGENTS.md` 里记的开发者前提是一条软链
 *
 *     node_modules -> <dsh 安装目录>/node_modules
 *
 * 那是给 Linux/macOS 与「`dsh` 是 npm 全局安装」的机器准备的。到了 Windows 桌面版，
 * 那三个被 Harness 注入的包（`schemastery` / `dsh-tools` / `dsh-llm`）**只存在于
 * `resources/app.asar/dsh/node_modules` 里面**（asar 归档里的一个虚拟目录），
 * 既没有对应的真实目录可以软链，Windows 上建软链/junction 又要额外权限
 * （实测在受限令牌下 `mklink /J` 直接 `Access is denied`）。
 *
 * 所以改成**按依赖闭包拷贝真实文件**：从一份 DSH 源码 checkout 出发，解析出
 * 三个入口包真正 import 到的每一个 `@deepseek-ai/*`，把它们平铺拷进本仓库的
 * `node_modules/`。平铺之后 Node 从任何一个拷贝出来的包往上找，都能在同级
 * `node_modules/@deepseek-ai/*` 命中 —— 不需要软链，也不需要 pnpm。
 *
 * 用法：
 *
 *     node scripts/dev-node-modules.mjs --from D:\deepseek-harness
 *     node scripts/dev-node-modules.mjs            # 自动探测 checkout 位置
 *
 * 它**只**影响本仓库的开发/测试（`node --test test/`），与插件运行时无关：
 * 插件本体是零依赖的，装到桌面版 profile 里之后依赖由 DSH 的运行时解析负责。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/dev-node-modules
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = join(repoRoot, 'node_modules');

/**
 * 插件真正 import 的三个包 —— 闭包从它们出发。
 *
 * 这里刻意写「包名 → 它在 monorepo 里的位置」而不是靠 Node 解析：workspace checkout 里
 * 没有一份能同时解析出这三个的 `node_modules`（根目录只提升了三个无关的包，
 * `packages/core/tools` 里有另外两个但没有它自己），而它们的目录名是稳定的。
 * 包名仍然写全 —— 拷贝与去重按包名走，`@deepseek-ai/dsh-tools` 必须落在
 * `node_modules/@deepseek-ai/dsh-tools`，否则插件 import 不到。
 */
const ENTRY_PACKAGES = [
  ['@deepseek-ai/schemastery', join('vendor', 'schemastery')],
  ['@deepseek-ai/dsh-tools', join('packages', 'core', 'tools')],
  ['@deepseek-ai/dsh-llm', join('packages', 'llm', 'llm')],
];

/** 探测 checkout 时的判据：一个必然存在的包的 manifest。 */
const ANCHOR = join('packages', 'core', 'tools', 'package.json');

/**
 * **只被测试用到**的包。插件本体是零依赖的，但 `test/bridge.test.mjs` 要一个真的
 * WebSocket 服务端（`ws`）和 YAML 解析（`js-yaml`）来搭假 Host —— 在 Linux 上这两个
 * 是由那条软链顺手带来的（`dsh` 的安装目录里本来就有），Windows 上没有软链就得显式拿。
 */
const EXTRA_PACKAGES = ['ws', 'js-yaml'];

/** 拷贝一个包时要跳过的目录/文件：源码、测试、缓存对运行没有意义，只会拖慢拷贝。 */
const SKIP_DIRS = new Set(['node_modules', 'src', 'test', 'tests', '__snapshots__', '.git']);
const SKIP_FILES = /(\.tsbuildinfo|\.map)$/;

/** 命令行的 `--from <dir>`：Windows 上路径里有反斜杠，别自作聪明去解析它。 */
function parseArgs(argv) {
  const args = { from: process.env.DSH_CHECKOUT ?? '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from' && argv[i + 1] !== undefined) {
      args.from = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/** 自动探测 DSH 源码 checkout：优先环境变量，其次几个常见位置。 */
function guessCheckout(explicit) {
  const candidates = [
    explicit,
    'D:\\deepseek-harness',
    join(process.env.USERPROFILE ?? '', 'deepseek-harness'),
    join(process.env.HOME ?? '', 'deepseek-harness'),
    '/deepseek-harness',
  ].filter((item) => typeof item === 'string' && item.length > 0);
  for (const candidate of candidates) {
    // 判据是锚点包存在，而不是目录存在 —— 一个空的同名目录不算 checkout。
    if (existsSync(join(candidate, ANCHOR))) return resolve(candidate);
  }
  return undefined;
}

/** 递归拷贝一个包目录：跳过源码/测试/缓存，别把几个 G 的 workspace 拖进来。 */
function copyPackage(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyPackage(source, destination);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.test(entry.name)) continue;
    copyFileSync(source, destination);
  }
}

/** 从已拷贝好的文件里抓出所有裸模块说明符（相对路径与 `node:` 与我们无关）。 */
function bareSpecifiers(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const pattern of [/from\s*["']([^"']+)["']/g, /require\(\s*["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']/g]) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** 一个包「运行时会被读到」的 js 文件：`lib/` 下的全部产出。 */
function runtimeFiles(packageDir) {
  const lib = join(packageDir, 'lib');
  if (!existsSync(lib)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(m?js|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(lib);
  return out;
}

/**
 * 从源码 checkout 里解析一个说明符。
 *
 * 关键：必须拿**源码目录里的文件**当锚点，而不是拷贝出来的那一份 —— 拷贝出来的
 * 包没有自己的 `node_modules`，从它出发只能往上找到本仓库这个还不完整的平铺目录，
 * 于是所有传递依赖都会「解析不到」。源码那边每个包都有 pnpm 铺好的 node_modules。
 */
function resolveSpecifier(anchorFile, specifier) {
  const require = createRequire(pathToFileURL(anchorFile));
  try {
    return dirname(require.resolve(`${specifier}/package.json`));
  } catch {
    try {
      return dirname(require.resolve(specifier));
    } catch {
      return undefined;
    }
  }
}

/** 合法的包名（含 scope），用来滤掉正则误抓到的片段（换行、逗号、模板串里的碎片）。 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*$/i;

/**
 * Node 内置模块要单独挡掉：CJS 包（`ws` 就是）里写的是 `require('zlib')` 这种**不带
 * `node:` 前缀**的写法，正则会把它们当成裸包名，于是我们会一本正经地把 `zlib`、`stream`
 * 这些内置模块「拷贝」进 `node_modules`（第一次跑就这么干了）。
 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/**
 * 在 checkout 里找一个裸包：先走 Node 自己的解析（workspace 提升过的那些），
 * 再退到 pnpm 的内容寻址目录 `.pnpm/<名>@<版本>/node_modules/<名>` ——
 * `ws` 就只在后者里（它没有被提升到根）。
 */
function findPackage(checkoutDir, name) {
  const fromRoot = resolveSpecifier(join(checkoutDir, 'package.json'), name);
  if (fromRoot !== undefined) return fromRoot;
  const store = join(checkoutDir, 'node_modules', '.pnpm');
  if (!existsSync(store)) return undefined;
  const prefix = `${name.replace('/', '+')}@`;
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = join(store, entry, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

const args = parseArgs(process.argv.slice(2));
const checkout = guessCheckout(args.from);
if (checkout === undefined) {
  console.error('找不到 DSH 源码 checkout。请用 `--from <目录>` 指定（该目录下要有 packages/preset/agent-presets）。');
  process.exit(1);
}
const anchorFile = join(checkout, ANCHOR);
console.log(`DSH checkout : ${checkout}`);
console.log(`目标 node_modules : ${targetRoot}`);
console.log(`（锚点 ${anchorFile} 只用来确认这确实是一份 checkout）`);

/** 待处理的包目录队列：解析 → 拷贝 → 扫它自己的 import → 继续。 */
const queue = [];
const done = new Set();
for (const [name, relative] of ENTRY_PACKAGES) {
  const dir = join(checkout, relative);
  if (!existsSync(dir)) {
    console.error(`checkout 里找不到 ${name}（预期在 ${dir}）`);
    process.exit(1);
  }
  queue.push({ name, dir });
}
for (const name of EXTRA_PACKAGES) {
  const dir = findPackage(checkout, name);
  if (dir === undefined) {
    console.warn(`  ! checkout 里找不到测试用的 ${name} —— bridge.test.mjs 会加载不了`);
    continue;
  }
  queue.push({ name, dir });
}

let copied = 0;
while (queue.length > 0) {
  const { name, dir } = queue.shift();
  if (done.has(name)) continue;
  done.add(name);
  copyPackage(dir, join(targetRoot, ...name.split('/')));
  copied += 1;
  console.log(`  + ${name}`);
  // 扫**源码**里的产出，再从源码解析依赖 —— 拷贝出来的那份没有 node_modules。
  for (const file of runtimeFiles(dir)) {
    for (const specifier of bareSpecifiers(file)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('#')) continue;
      const parts = specifier.split('/');
      const bare = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (BUILTINS.has(bare) || !PACKAGE_NAME.test(bare) || done.has(bare)) continue;
      const resolved = resolveSpecifier(file, bare);
      if (resolved === undefined) {
        console.warn(`  ! 解析不到 ${specifier}（来自 ${name}）—— 测试可能会因此失败`);
        continue;
      }
      queue.push({ name: bare, dir: resolved });
    }
  }
}
console.log(`完成：拷贝了 ${copied} 个包到 ${targetRoot}`);
console.log('接下来可以跑：node --test test/');
