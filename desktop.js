/**
 * 「把插件装进桌面版的 profile」这一步里**纯**的那一半：改 `.env` 与改 `package.json`。
 *
 * 为什么值得单独一个模块：这两处都是**用户的文件**（`.env` 里可能有别的东西、
 * `package.json` 是 Electron 自己也在写的东西），改错了的代价远大于「功能没生效」——
 * 轻则配置漂移，重则桌面版起不来。所以把「怎么改」提成纯函数（给文本/对象、返回新值），
 * 由 `scripts/napcat-setup.mjs` 负责读写，`test/desktop.test.mjs` 负责钉住幂等性与
 * 「不许动别人的东西」这两条。
 *
 * 这个模块不 import `index.js`，也不碰磁盘（`node:fs` 不 import —— `pluginLinkState` 需要的
 * 两个读操作由调用方当参数传进来，所以它照样能在测试里喂假数据）。
 *
 * @module @qqbot/dsh-plugin-qq/desktop
 */

/** 插件自己的包名（写进 profile 的依赖与 bundles 列表）。 */
export const PLUGIN_NAME = '@qqbot/dsh-plugin-qq';

/**
 * `.env` 里那一段的起止标记。
 *
 * 用一个**带标记的段落**而不是「按 key 找行替换」：前者重复运行的结果是确定的
 * （整段替换，行数不涨），后者在注释、重复键、CRLF 这些情况下会一点点长歪。
 * 标记里写清是哪个脚本维护的，用户打开文件就知道那几行不是自己写的。
 */
export const ENV_BLOCK_START = '# ---- qq-bridge（本段由 scripts/napcat-setup.mjs 维护，重复运行会整段替换）----';
export const ENV_BLOCK_END = '# ---- qq-bridge 结束 ----';

/**
 * 把 `KEY=value` 写进 `.env` 的维护段落里，其余内容**一个字节都不动**。
 *
 * @param text - 原文件正文（文件不存在时传空串）。
 * @param values - 要写入的键值对（顺序即写入顺序）。
 * @returns 新的正文（内容没变时与原串相等）。
 */
export function applyEnvBlock(text, values) {
  const source = String(text ?? '');
  const block = [ENV_BLOCK_START, ...Object.entries(values ?? {}).map(([key, value]) => `${key}=${String(value ?? '')}`), ENV_BLOCK_END];
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const from = lines.findIndex((line) => line.trim() === ENV_BLOCK_START);
  const to = lines.findIndex((line) => line.trim() === ENV_BLOCK_END);
  const next = from !== -1 && to > from
    ? [...lines.slice(0, from), ...block, ...lines.slice(to + 1)]
    : [...(lines.length > 0 && lines[lines.length - 1].trim() === '' ? lines.slice(0, -1) : lines), ...(lines.length > 0 ? [''] : []), ...block, ''];
  return next.join('\n');
}

/**
 * 往 profile 的 manifest 里加上「依赖 + bundles」两项。
 *
 * DSH 的 profile 约定：`dependencies` 里是包，`dsh.profile.bundles` 里是**启用的** bundle
 * 列表（内置的在前，插件在后）。只改依赖不改 bundles 的话，插件装上了却不会被加载 ——
 * 这正是「明明装了却不生效」最常见的原因，所以两件事必须一起做、也必须一起判幂等
 * （只差一个的时候要能补上另一个，而不是整个跳过）。
 *
 * @param manifest - profile 的 `package.json` 解析结果。
 * @param repoRoot - 插件仓库的绝对路径。
 * @param name - 插件包名（默认 {@link PLUGIN_NAME}）。
 * @returns `{ changed, manifest }`：`changed` 为假时原对象原样返回。
 */
export function withPluginInstalled(manifest, repoRoot, name = PLUGIN_NAME) {
  const base = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
  const dependencies = { ...(base.dependencies ?? {}) };
  const dsh = { ...(base.dsh ?? {}) };
  const profile = { ...(dsh.profile ?? {}) };
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : [];
  const spec = `link:${repoRoot}`;
  let changed = false;
  if (dependencies[name] !== spec) {
    dependencies[name] = spec;
    changed = true;
  }
  if (!bundles.includes(name)) {
    bundles.push(name);
    changed = true;
  }
  if (!changed) return { changed: false, manifest: base };
  return {
    changed: true,
    manifest: {
      ...base,
      dependencies,
      dsh: { ...dsh, profile: { ...profile, bundles } },
    },
  };
}

/**
 * 路径比对的归一：斜杠方向、大小写、末尾分隔符都不该影响「是不是同一个目录」。
 *
 * 为什么两边都忽略大小写：同一条路径经 `realpath`（盘符与短名会被规范化）、junction 里存的原样
 * 与 `process.cwd()`（用户敲进去的大小写）三处出来可能不一样，而它们指的是同一个目录 ——
 * 宁可放过「大小写真的不同」这种病态情况，也不要因为盘符大写就误判成「指向别处」而白重建一次链接。
 *
 * @param value - 任意路径（可能是 undefined / 空串）。
 * @returns 归一后的字符串；空值返回空串。
 */
function canonicalPathOf(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * `node_modules` 里那个链接现在指着谁。
 *
 * 为什么要单独回答这个问题：解析完全由链接决定（`dependencies` 里那行 `link:` 只是给
 * pnpm / 插件管理器看的声明），所以「链接指着 A、manifest 写着 B」是一种**没有任何报错**的
 * 错装 —— 用户看到的是「明明装了新版本，行为还是旧的」。判断只能靠读链接本身。
 *
 * 读法为什么是**一串**回退（三个都是实测出来的，别顺手删掉任何一个）：
 *
 *   1. `realpathSync.native` —— Windows 上的 junction / 挂载点只有它能解析到真实目标
 *      （`readlink` 对 reparse point 一律 `EINVAL`，而普通 `realpathSync` 有时把链接本身当结果返回：
 *      实测同一台机器上 `native` 给出 `D:\...\0.1.1`、普通版给出链接自己的路径）。POSIX 上它也照常解析软链接；
 *   2. `realpathSync` —— `native` 拿不到答案时的退路（也是 POSIX 上的主力）；
 *   3. `readlinkSync` —— 目标**已经不存在**时唯一还有答案的读法（POSIX 的软链接；相对目标由
 *      调用方按链接所在目录拼绝对路径是 `realpath` 的语义，这里只拿到原样的字符串）。
 *
 * 三样全失败只发生在「Windows + 链接的目标已经被删掉」这一种情况：那时**我们读不出它指着谁**，
 * 于是返回 `unknown` 让调用方自己决定（脚本那边会重建 —— 对它来说重建是无损的）。
 *
 * @param linkPath - 链接自身的绝对路径。
 * @param repoRoot - 期望它指向的仓库绝对路径。
 * @param fs - 读操作用的 `node:fs` 子集（默认真 fs，测试注入假的）。
 * @returns `{ state, target }`：`state` 是 `missing`（链接不存在）/ `linked`（指向 repoRoot）/
 *          `elsewhere`（指向别处）/ `unknown`（读不出指向）/ `not-a-link`（那里是个真的文件）；
 *          `target` 是能读到时的实际指向（读不出来时 `undefined`）。
 */
export function pluginLinkState(linkPath, repoRoot, fs = {}) {
  const wanted = canonicalPathOf(repoRoot);
  /** 读不出来就 `undefined`（每条路失败的原因不同，而调用方只关心「有没有答案」）。 */
  const attempt = (fn) => {
    try {
      const value = fn();
      return value === undefined || value === null || String(value).length === 0 ? undefined : String(value);
    } catch {
      return undefined;
    }
  };
  // 先分清「不存在」与「存在但不是链接」：把普通目录当成链接去解析，会得到
  // 「realpath = 它自己 = 指向别处」，于是脚本会把用户手工拷进来的插件目录删掉。
  // （这一处刻意不走 `attempt`：它要的是 `Stats` 对象，不是字符串。）
  let info;
  try {
    info = fs.lstatSync?.(linkPath);
  } catch {
    info = undefined;
  }
  if (info === undefined || info === null) return { state: 'missing', target: undefined };
  if (!info.isSymbolicLink() && !info.isDirectory()) return { state: 'not-a-link', target: undefined };
  const native = fs.realpathSync?.native ?? fs.realpathSync;
  const resolved = attempt(() => native?.(linkPath))
    ?? attempt(() => (fs.realpathSync === native ? undefined : fs.realpathSync?.(linkPath)))
    ?? attempt(() => fs.readlinkSync?.(linkPath));
  if (resolved === undefined) return { state: 'unknown', target: undefined };
  // 解析结果就是链接自己时同样是 elsewhere：那是「没被跟下去的链接」（Windows 上普通
  // `realpathSync` 的表现），不是「它指着自己」这种病态情况 —— 重建一次正好修正它。
  return { state: canonicalPathOf(resolved) === wanted ? 'linked' : 'elsewhere', target: resolved };
}

/**
 * 删掉一条链接（`node_modules` 里那条），好把新的建上去。
 *
 * 为什么不是 `unlink`：Windows 的 junction 不是普通的符号链接 —— `fs.unlink` 对它一律
 * `EPERM`（实测）。`fs.rmdir` 才是删 reparse point 的正解，而且它**只删链接本身、不动目标**
 * （实测：删完链接消失、目标里的文件还在）。顺序因此是「先 unlink（POSIX 的软链接与普通
 * 文件）」，不行再 rmdir。
 *
 * 刻意**不**用 `rm -r`：`fs.rm` 的递归删除会走进去把目标目录的内容也删掉 —— 那是「删掉用户
 * 的仓库」级别的破坏，而这里要的只是抹掉一条指向。
 *
 * 副作用是刻意的：失败时**不抛错**，让调用方去说「请自己在插件页里重装」。这条路上失败
 * 通常意味着权限问题，把异常扔出去只会让输出变成一段栈。
 *
 * @param linkPath - 链接自身的绝对路径（调用方已确认它不是真目录）。
 * @param fs - `{ unlinkSync, rmdirSync }`（默认真 fs，测试注入假的）。
 * @returns 成功了没有。
 */
export function removePluginLink(linkPath, fs = {}) {
  try {
    fs.unlinkSync?.(linkPath);
    return true;
  } catch {
    // 继续试 rmdir：Windows 的 junction 走的就是这一条。
  }
  try {
    fs.rmdirSync?.(linkPath);
    return true;
  } catch {
    return false;
  }
}
