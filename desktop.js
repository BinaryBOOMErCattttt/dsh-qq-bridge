/**
 * 「把插件装进桌面版的 profile」这一步里**纯**的那一半：改 `.env` 与改 `package.json`。
 *
 * 为什么值得单独一个模块：这两处都是**用户的文件**（`.env` 里可能有别的东西、
 * `package.json` 是 Electron 自己也在写的东西），改错了的代价远大于「功能没生效」——
 * 轻则配置漂移，重则桌面版起不来。所以把「怎么改」提成纯函数（给文本/对象、返回新值），
 * 由 `scripts/napcat-setup.mjs` 负责读写，`test/desktop.test.mjs` 负责钉住幂等性与
 * 「不许动别人的东西」这两条。
 *
 * 这个模块不 import `index.js`，也不碰磁盘。
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
