/**
 * 受信写盘：给「主人」用的文件编辑能力（`qq_write` / `qq_edit` / `qq_skill` 的实现）。
 *
 * 为什么需要它，以及为什么不是直接放开 `write` / `edit`：
 *
 *   1. QQ 会话的 Agent 是**一个群一个**，群里谁都能触发它。`tools.restrict()` 是按
 *      Agent（会话）收窄的，没法按「这一句话是谁说的」收窄 —— 一旦把内建的 `write`
 *      放进来，群友说一句「把 xxx 改了」也能写。所以写盘只能走**自己的工具**，在
 *      `execute()` 里核对**当前这一轮的发言人**（见 index.js 的 `writeAuthority`）。
 *   2. 内建 `write` 能写到 cwd 里的任何地方，包括 `data/` 与 `.qq-memory/`（那两处
 *      有各自的格式护栏）。这里只放开「部署者资产」：人设、表达、工作目录内的 skill，
 *      以及工作目录之外的 `~/.dsh/skills`（`qq_skill`，只碰 `SKILL.md`）。
 *   3. 写之前留一份备份（`cwd/.dsh/.history/`），改坏了能人工翻回去 —— 人设文件写坏
 *      时 `docfile.js` 会回退上一版，但 skill 没有这层保护。
 *
 * 这个模块**不碰闭包状态**：根目录、上限、日志函数都由 `createEditor()` 传进来，
 * 于是可以用临时目录单测（见 test/editor.test.mjs）。
 *
 * @module @qqbot/dsh-plugin-qq/editor
 */
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';

import { insideDirectory } from './image.js';

/** 允许写的扩展名：全是文本资产；图片/二进制走 `qq_save_sticker`。 */
export const WRITE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml'];

/**
 * 工作目录里**不许**用这几个工具碰的一级目录：
 * `data/` 与 `.qq-memory/` 有自己的格式护栏，`.qq-media/` / `.qq-stickers/` 是二进制
 * 缓存，`.git` / `node_modules` 是仓库与依赖。
 */
export const DENIED_ROOTS = ['.qq-memory', '.qq-media', '.qq-stickers', 'data', '.git', 'node_modules'];

/** 备份目录（相对 cwd）。 */
export const HISTORY_DIR = '.dsh/.history';

/** skill 目录名：单层、小写、不含路径分隔符。 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 单个文本文件的上限（字符数兜底；实际按字节再判一次）。 */
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * 把用户/模型给的相对路径洗成 `a/b/c.md` 形状；越界或绝对路径直接抛错。
 * @param {unknown} raw - 原始路径。
 * @returns {string} 正斜杠分隔的相对路径。
 */
export function sanitizeRelativePath(raw) {
  const text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (text.length === 0) throw new Error('path 不能为空');
  if (text.includes('\u0000')) throw new Error('path 里不能有 NUL 字符');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new Error('只能写工作目录里的相对路径，不能写绝对路径（skill 用 qq_skill）');
  }
  const parts = text.split('/');
  if (parts.some((part) => part === '..')) throw new Error('path 里不能有 `..`');
  const clean = parts.filter((part) => part.length > 0 && part !== '.').join('/');
  if (clean.length === 0) throw new Error('path 不能为空');
  if (clean.length > 200) throw new Error('path 太长（超过 200 字符）');
  return clean;
}

/**
 * 这个相对路径能不能用写盘工具改；能改返回 undefined，否则返回一句人话原因。
 * @param {string} relativePath - 已用 `sanitizeRelativePath` 洗过的路径。
 * @returns {string | undefined}
 */
export function writableTargetReason(relativePath) {
  const parts = String(relativePath).split('/');
  const top = parts[0] ?? '';
  if (DENIED_ROOTS.includes(top)) {
    return `\`${top}/\` 不让 qq_write / qq_edit 改（${top === 'data' || top === '.qq-memory' ? '记忆与数据文件有各自的格式护栏，用 qq_memory' : '这是缓存/依赖目录'}）`;
  }
  const extension = extname(relativePath).toLowerCase();
  if (!WRITE_EXTENSIONS.includes(extension)) {
    return `只允许改文本文件（${WRITE_EXTENSIONS.join(' / ')}），这个扩展名不在名单里`;
  }
  return undefined;
}

/**
 * 把 `old_text` 换成 `new_text`；`old_text` 必须**恰好出现一次**。
 *
 * 为什么要求唯一：模型很容易给一句「出现处很多」的片段（比如一个标题），替换第一处
 * 往往不是它想改的那一处。让它多带一点上下文，比事后猜它想改哪里可靠。
 * @param {string} text - 原文。
 * @param {string} oldText - 要替换的片段。
 * @param {string} newText - 替换成什么（空串 = 删除）。
 * @returns {string} 新正文。
 */
export function applyPatch(text, oldText, newText) {
  const source = String(text ?? '');
  const find = String(oldText ?? '');
  if (find.length === 0) throw new Error('old_text 不能为空（要追加内容请用 action: write 或 qq_write）');
  let count = 0;
  let index = source.indexOf(find);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(find, index + find.length);
  }
  if (count === 0) throw new Error('old_text 在这份文件里没有出现：先用 read / qq_skill read 看一眼原文');
  if (count > 1) throw new Error(`old_text 出现了 ${count} 次，改哪一处不明确；多带几行上下文让它唯一`);
  return source.slice(0, source.indexOf(find)) + String(newText ?? '') + source.slice(source.indexOf(find) + find.length);
}

/**
 * skill 目录名是否合法。
 * @param {unknown} name
 * @returns {boolean}
 */
export function skillNameOk(name) {
  return SKILL_NAME_PATTERN.test(String(name ?? ''));
}

/** 把异常压成一句能写进工具结果的话。 */
function reasonOf(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

/**
 * 造一个编辑器。所有根目录都在这里固定下来，工具层只调用方法。
 *
 * @param {object} options
 * @param {string} options.cwd - Agent 工作目录（沙箱根），也是普通写盘的上界。
 * @param {string} options.skillRoot - `~/.dsh/skills`（`qq_skill` 的上界）。
 * @param {number} [options.maxBytes] - 单个文件字节上限。
 * @param {number} [options.historyLimit] - 备份保留份数。
 * @param {(level: string, message: string) => void} [options.report] - 日志。
 */
export function createEditor({ cwd, skillRoot, maxBytes = DEFAULT_MAX_BYTES, historyLimit = 200, report = () => {} }) {
  const root = resolve(cwd);
  const skills = resolve(skillRoot);
  const historyRoot = join(root, HISTORY_DIR);
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : DEFAULT_MAX_BYTES;

  /** 目标绝对路径必须真的在根里（防 `sanitize` 之后的符号链接/大小写把戏）。 */
  function assertInside(base, absolute, label) {
    if (!insideDirectory(resolve(base), resolve(absolute))) {
      throw new Error(`${label} 越界：只允许改 ${base} 里的文件`);
    }
  }

  /** 目标存在时必须是普通文件，不能是符号链接或目录。 */
  async function assertRegularFile(absolute) {
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('拒绝写入符号链接');
    if (!info.isFile()) throw new Error('目标不是普通文件');
    return true;
  }

  async function readText(absolute) {
    try {
      return await readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** 写前备份到 `cwd/.dsh/.history/`，并清掉超出上限的旧备份。 */
  async function backup(absolute, label) {
    const previous = await readText(absolute);
    if (previous === undefined) return undefined;
    await mkdir(historyRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = label.replace(/[\\/]+/g, '_').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file';
    const target = join(historyRoot, `${slug}.${stamp}.bak`);
    await writeFile(target, previous, 'utf8');
    await pruneHistory();
    return target;
  }

  async function pruneHistory() {
    try {
      const names = (await readdir(historyRoot)).filter((name) => name.endsWith('.bak'));
      if (names.length <= historyLimit) return;
      const rows = await Promise.all(names.map(async (name) => {
        const full = join(historyRoot, name);
        const info = await stat(full).catch(() => undefined);
        return { full, at: info?.mtimeMs ?? 0 };
      }));
      rows.sort((left, right) => left.at - right.at);
      for (const row of rows.slice(0, Math.max(0, rows.length - historyLimit))) {
        await unlink(row.full).catch(() => {});
      }
    } catch (error) {
      report('warn', `editor: could not prune backups: ${reasonOf(error)}`);
    }
  }

  async function writeAtomic(absolute, content) {
    await mkdir(dirname(absolute), { recursive: true });
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, content, 'utf8');
    await rename(temp, absolute);
  }

  function assertSize(content, label) {
    const bytes = Buffer.byteLength(String(content ?? ''), 'utf8');
    if (bytes > limit) throw new Error(`${label} 有 ${bytes} 字节，超过上限 ${limit}；大文件请拆开或别用写盘工具`);
    return bytes;
  }

  function resolveTarget(relativePath) {
    const clean = sanitizeRelativePath(relativePath);
    const reason = writableTargetReason(clean);
    if (reason !== undefined) throw new Error(reason);
    const absolute = resolve(root, clean);
    assertInside(root, absolute, 'path');
    return { clean, absolute };
  }

  return {
    /** 工作目录里的文件（读）。 */
    async read(relativePath) {
      const { clean, absolute } = resolveTarget(relativePath);
      const text = await readText(absolute);
      if (text === undefined) throw new Error(`${clean} 不存在`);
      return { path: clean, content: text, bytes: Buffer.byteLength(text, 'utf8') };
    },

    /** 整份写入（覆盖；写前备份）。 */
    async write(relativePath, content) {
      const { clean, absolute } = resolveTarget(relativePath);
      const bytes = assertSize(content, clean);
      const backupPath = await backup(absolute, clean);
      await writeAtomic(absolute, String(content ?? ''));
      return { path: clean, bytes, backup: backupPath };
    },

    /** 唯一匹配替换。 */
    async patch(relativePath, oldText, newText) {
      const { clean, absolute } = resolveTarget(relativePath);
      const previous = await readText(absolute);
      if (previous === undefined) throw new Error(`${clean} 不存在`);
      const next = applyPatch(previous, oldText, newText);
      assertSize(next, clean);
      const backupPath = await backup(absolute, clean);
      await writeAtomic(absolute, next);
      return { path: clean, bytes: Buffer.byteLength(next, 'utf8'), backup: backupPath };
    },

    /** `~/.dsh/skills` 下的 skill 目录名（只列有 SKILL.md 的）。 */
    async skillList() {
      const names = await readdir(skills, { withFileTypes: true }).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      const out = [];
      for (const entry of names) {
        if (!entry.isDirectory() || !skillNameOk(entry.name)) continue;
        const file = join(skills, entry.name, 'SKILL.md');
        const info = await stat(file).catch(() => undefined);
        if (info?.isFile()) out.push(entry.name);
      }
      return out.sort();
    },

    /** 读一份 skill 的 SKILL.md。 */
    async skillRead(name) {
      const file = skillFile(name);
      const text = await readText(file);
      if (text === undefined) throw new Error(`skill「${name}」不存在（用 action: list 看有哪些）`);
      return { name: String(name), content: text, bytes: Buffer.byteLength(text, 'utf8') };
    },

    /** 整份重写一份 skill 的 SKILL.md（写前备份）。 */
    async skillWrite(name, content) {
      const file = skillFile(name);
      const bytes = assertSize(content, `skills/${name}/SKILL.md`);
      const backupPath = await backup(file, `skills/${name}/SKILL.md`);
      await writeAtomic(file, String(content ?? ''));
      return { name: String(name), bytes, backup: backupPath };
    },

    /** 唯一匹配替换一份 skill 的 SKILL.md。 */
    async skillPatch(name, oldText, newText) {
      const file = skillFile(name);
      const previous = await readText(file);
      if (previous === undefined) throw new Error(`skill「${name}」不存在（用 action: list 看有哪些）`);
      const next = applyPatch(previous, oldText, newText);
      assertSize(next, `skills/${name}/SKILL.md`);
      const backupPath = await backup(file, `skills/${name}/SKILL.md`);
      await writeAtomic(file, next);
      return { name: String(name), bytes: Buffer.byteLength(next, 'utf8'), backup: backupPath };
    },
  };

  /** skill 名 → 绝对路径；名字不合法或目录不存在时抛错。 */
  function skillFile(name) {
    const clean = String(name ?? '').trim();
    if (!skillNameOk(clean)) {
      throw new Error('skill 名不合法：只允许小写字母/数字/._-，单层目录名（例如 qq-bot-notes）');
    }
    const absolute = join(skills, clean, 'SKILL.md');
    assertInside(skills, absolute, 'skill');
    return absolute;
  }
}

/**
 * 默认的 skill 根目录：`$DSH_HOME/skills`，没有 DSH_HOME 时用 `~/.dsh/skills`。
 * @returns {string} 绝对路径。
 */
export function defaultSkillRoot() {
  const home = String(process.env.DSH_HOME ?? '').trim();
  return home.length > 0 ? join(resolve(home), 'skills') : join(homedir(), '.dsh', 'skills');
}

/** 把配置里的路径展开成绝对路径（支持 `~` 开头，空串由调用方决定默认值）。 */
export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return resolve(text);
}
