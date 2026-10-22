/**
 * 「真的忘掉一个 QQ 会话」—— 计划与执行。
 *
 * `/reset` 只换一个空会话：长期记忆（转录 / `MEMORY.md`）、旧会话存档、索引里的引用都还在，
 * 所以它回答不了「把这个人的聊天记录清掉」。这个脚本把三类东西一起处理：
 *
 *   1. `<memoryDir>/conversations/<slug>/` —— 转录、`MEMORY.md`、`archive/`、`meta.json`；
 *   2. `INDEX.md` 里指向它的那一行，和 `memory.index.json` 里它的派生统计；
 *   3. 这个会话第 0..N 轮的 DSH 会话存档，以及 reset 代次（+1，避免重启后 resume 回来）。
 *
 * 为什么不是 QQ 侧的工具：QQ 消息是**不可信输入**（AGENTS.md §5.6），让群友一句话清库
 * 显然不行。这是操作员的运维动作，入口只有 `scripts/ops.mjs forget`。
 *
 * 为什么先备份：删的是真数据（转录是摘要的原料，会话存档是上下文）。备份默认写到
 * cwd 之外的 `~/qqbot-forget-backups/`，也是**故意**的 —— 放在 cwd 里，QQ 会话的只读
 * 文件工具就能把刚删掉的私聊记录再读回来。
 *
 * 三条边界：
 *   - `memoryDir` 必须在 cwd 内（与插件自己的校验同一条规则）；
 *   - 只按 `memorySlug(key)` 算出来的那一个目录动手，不扫别的会话；
 *   - DSH 会话存档按**确定性 id**（`sessionIdFor`）找，不按内容猜。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/forget
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { localStamp, memorySlug, pathInside, sessionIdFor } from '../util.js';
import { readTextOrUndefined, writeJsonAtomic, writeTextAtomic } from '../filestore.js';

/** 摘要会话的固定 key（见 memory.js 的 `digestSessionId`）。 */
const DIGEST_KEY = 'bridge:digest';
const DEFAULT_MEMORY_DIR = '.qq-memory';
const DEFAULT_MEDIA_DIR = '.qq-media';
/** QQ 号至少三位：太短的 key 更像手滑打出来的，宁可拒绝。 */
const KEY_PATTERN = /^(group|private):([0-9]{3,})$/;
/** 递归统计的上限：坏掉的树上不该转圈（与 ops.mjs 的 cleanup 同一个理由）。 */
const MAX_DEPTH = 8;
const MAX_FILES = 5000;
/** reset 代次的上限：一个被手工改坏成 10^9 的标记不该让我们 loop 十亿次。 */
const MAX_ROUND = 10000;

/**
 * 解析 `group:100000001` / `private:100000002`。
 * @param raw - 命令行给的那一段。
 * @returns `{ key, type, id }`；不合法时 `undefined`（调用方给用法，不猜）。
 */
export function parseForgetKey(raw) {
  const key = String(raw ?? '').trim();
  const match = KEY_PATTERN.exec(key);
  if (match === null) return undefined;
  return { key, type: match[1], id: match[2] };
}

/**
 * DSH 会话存储的「项目目录名」。
 *
 * 为什么要在插件仓库里复刻这一段：`forget` 是独立脚本，拿不到 Harness 的
 * `sessionPersistence` 服务，只能从文件系统找存档。编码规则来自
 * `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey()`：分隔符与冒号折成
 * `-`，非法码元写成 `~XXXX`，首尾各包 `--`。它变了的话宁可找不到存档（命令会报
 * 「没找到会话存档」），也不该去删别人的目录 —— 所以调用方还可以用
 * `--sessions-dir` 直接指定项目目录。
 * @param cwd - 项目目录（绝对路径）。
 * @returns 例如 `/home/u/qqbot` → `--home-u-qqbot--`。
 */
export function sessionProjectKey(cwd) {
  const text = String(cwd ?? '');
  if (text.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * 把一次 `forget` 会碰到的路径全部算出来（纯路径，不读不写）。
 *
 * @param options - `{ key, cwd, memoryDir?, mediaDir?, sessionsRoot, sessionsDir? }`。
 * @returns 目标路径与 key 的解析结果。
 */
export function forgetTargets(options = {}) {
  const parsed = parseForgetKey(options.key);
  if (parsed === undefined) {
    throw new Error(`不是合法的会话 key：「${String(options.key ?? '')}」（应当形如 group:100000001 / private:100000002）`);
  }
  const cwd = resolve(String(options.cwd ?? process.cwd()));
  const memoryRoot = resolve(cwd, String(options.memoryDir ?? DEFAULT_MEMORY_DIR));
  if (!pathInside(cwd, memoryRoot)) {
    throw new Error(`memoryDir 落在 cwd 之外（${memoryRoot}）：拒绝清除（与插件同一条写边界）`);
  }
  const mediaRoot = resolve(cwd, String(options.mediaDir ?? DEFAULT_MEDIA_DIR));
  if (!pathInside(cwd, mediaRoot)) {
    throw new Error(`mediaDir 落在 cwd 之外（${mediaRoot}）：拒绝清除`);
  }
  const sessionsRoot = resolve(String(options.sessionsRoot ?? join(homedir(), '.dsh', 'sessions')));
  const projectRoot = options.sessionsDir === undefined
    ? join(sessionsRoot, sessionProjectKey(cwd))
    : resolve(String(options.sessionsDir));
  const slug = memorySlug(parsed.key);
  return {
    ...parsed,
    cwd,
    memoryRoot,
    mediaRoot,
    sessionsRoot,
    projectRoot,
    resetFile: join(sessionsRoot, 'reset', `${slug}.json`),
    slug,
    conversationDir: join(memoryRoot, 'conversations', slug),
    indexPath: join(memoryRoot, 'INDEX.md'),
    statsPath: join(memoryRoot, 'memory.index.json'),
    historyDir: join(memoryRoot, '.history'),
    digestDir: join(projectRoot, sessionIdFor(DIGEST_KEY)),
  };
}

/** 递归数一个目录里有多少文件、共多少字节；不存在就是 0。 */
function describePath(dir) {
  const files = [];
  const walk = (current, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      let bytes = 0;
      try {
        bytes = statSync(full).size;
      } catch {
        bytes = 0;
      }
      files.push({ path: full, bytes });
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return {
    exists: existsSync(dir),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/**
 * `INDEX.md` 里有多少行指向这个会话。
 *
 * 匹配 `conversations/<slug>/` 前缀（而不是逐字匹配 `MEMORY.md`）：索引的措辞以后可能
 * 加东西，但路径前缀是这个会话的身份，去掉它才是对的。
 */
async function inspectIndex(path, slug) {
  const text = await readTextOrUndefined(path);
  if (text === undefined) return { exists: false, removed: 0, next: undefined };
  const lines = text.split('\n');
  const needle = `conversations/${slug}/`;
  const kept = lines.filter((line) => !line.includes(needle));
  const removed = lines.length - kept.length;
  return { exists: true, removed, next: kept.join('\n') };
}

/** `memory.index.json` 里有多少条统计属于这个会话（`fact:private:<号>:…` 之类）。 */
async function inspectStats(path, key) {
  const text = await readTextOrUndefined(path);
  if (text === undefined) return { exists: false, removed: 0, next: undefined, error: undefined };
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    // 坏 JSON 不覆盖：删掉统计只是丢缓存，把一份坏文件写成新的反而更像「修好了」。
    return { exists: true, removed: 0, next: undefined, error: String(error?.message ?? error) };
  }
  const stats = data?.stats;
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
    return { exists: true, removed: 0, next: undefined, error: undefined };
  }
  const pattern = new RegExp(`(^|:)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`);
  const kept = {};
  const removedKeys = [];
  for (const [name, value] of Object.entries(stats)) {
    if (pattern.test(name)) removedKeys.push(name);
    else kept[name] = value;
  }
  return {
    exists: true,
    removed: removedKeys.length,
    next: removedKeys.length === 0 ? undefined : `${JSON.stringify({ ...data, stats: kept }, null, 2)}\n`,
    error: undefined,
  };
}

/** 读 reset 标记（第几轮）；坏文件按第 0 轮算，跟插件的失败语义一致。 */
async function readRound(path) {
  const text = await readTextOrUndefined(path);
  if (text === undefined) return { exists: false, count: 0 };
  try {
    const parsed = JSON.parse(text);
    const count = parsed?.count;
    if (Number.isSafeInteger(count) && count >= 0 && count <= MAX_ROUND) {
      return { exists: true, count };
    }
  } catch {
    // 单个标记坏了只影响这个会话；forget 仍然可以按第 0 轮处理。
  }
  return { exists: true, count: 0 };
}

/**
 * 记忆文件的旧版本备份（`memory.js` 的 `backupMemoryFile` 落的那批）。
 *
 * 为什么也要删：`MEMORY.md` 每次写入前都会把旧正文备份成
 * `.history/conversations_<slug>_MEMORY.md.<时间>.md`。只删热层的话，旧正文还躺在
 * 那里 —— 对「忘掉」来说等于没删。备份文件名里的分隔符由 `backupMemoryFile` 用 `_`
 * 拍平，所以这里按同一个前缀找。
 */
function inspectHistory(dir, slug) {
  const prefix = `conversations_${slug}_MEMORY.md.`;
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(dir, name);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = 0;
    }
    return { name, path, bytes };
  });
}

/** 递归列出一个目录下的 `.md`（只用于找 MEMORY.md / archive 里的媒体引用）。 */
function markdownFiles(dir) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** 把记忆目录里除目标会话外的文本都读出来（判断一个媒体路径还有没有人引用）。 */
async function textElsewhere(root, skipDir, skipFiles) {
  const texts = [];
  const walk = async (current, depth) => {
    if (depth > MAX_DEPTH || texts.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (resolve(full) === resolve(skipDir)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(md|json|jsonl)$/.test(entry.name)) continue;
      if (skipFiles.has(resolve(full))) continue;
      const text = await readTextOrUndefined(full);
      if (text !== undefined) texts.push(text);
    }
  };
  await walk(root, 0);
  return texts;
}

/**
 * 目标会话的 `MEMORY.md` / `archive/` 里引用的 `.qq-media` 文件。
 *
 * 只在 `--with-media` 时才算：`.qq-media` 是 LRU 缓存，不是记忆的真相；默认不动它。
 * 就算开了，也只删「文件存在、且在记忆目录别处已经没人引用」的那些。
 *
 * 两个「别处」要排除：
 *   - `memory.index.json` 是派生索引，马上就会被剪掉，它里面的路径不算引用；
 *   - 这个会话自己的 `.history` 备份也马上会被删，同样不算引用。
 */
async function mediaCandidates(target, history) {
  if (!existsSync(target.conversationDir)) return [];
  const refs = new Set();
  for (const file of markdownFiles(target.conversationDir)) {
    const text = await readTextOrUndefined(file);
    if (text === undefined) continue;
    for (const match of text.matchAll(/\.qq-media\/[A-Za-z0-9][A-Za-z0-9._-]*/g)) refs.add(match[0]);
  }
  if (refs.size === 0) return [];
  const skipFiles = new Set([resolve(target.statsPath), ...history.map((item) => resolve(item.path))]);
  const others = await textElsewhere(target.memoryRoot, target.conversationDir, skipFiles);
  return [...refs].map((ref) => {
    const absolute = resolve(target.cwd, ref);
    return {
      ref,
      absolute,
      exists: pathInside(target.mediaRoot, absolute) && existsSync(absolute),
      referencedElsewhere: others.some((text) => text.includes(ref)),
    };
  });
}

/**
 * 只读的计划：算清楚「会删什么、删多少」，不碰任何文件。
 *
 * @param options - {@link forgetTargets} 的入参 + `withMedia`（是否计算媒体候选）。
 * @returns 计划对象，交给 {@link applyForget}。
 */
export async function planForget(options = {}) {
  const target = forgetTargets(options);
  const conversation = describePath(target.conversationDir);
  const index = await inspectIndex(target.indexPath, target.slug);
  const stats = await inspectStats(target.statsPath, target.key);
  const round = await readRound(target.resetFile);
  const generations = [];
  for (let generation = 0; generation <= round.count; generation += 1) {
    const id = sessionIdFor(target.key, generation);
    const dir = join(target.projectRoot, id);
    if (!existsSync(dir)) continue;
    generations.push({ generation, id, dir, ...describePath(dir) });
  }
  const digest = { id: sessionIdFor(DIGEST_KEY), dir: target.digestDir, ...describePath(target.digestDir) };
  const history = inspectHistory(target.historyDir, target.slug);
  const media = options.withMedia === true ? await mediaCandidates(target, history) : [];
  return {
    target,
    conversation,
    index,
    stats,
    round,
    generations,
    digest,
    history,
    media,
    nextRound: round.count + 1,
  };
}

/** 备份目录里那份「怎么恢复」的说明。 */
function restoreNote(plan, stamp) {
  const { target } = plan;
  return [
    `${target.key}（${target.slug}）记忆清除前的备份 —— ${stamp}`,
    '',
    'memory/      长期记忆（转录 / MEMORY.md / archive/ / meta.json）',
    'index/       INDEX.md 与 memory.index.json（清除前的原样）',
    'history/     这个会话的 MEMORY.md 旧版本备份（.history 里那批）',
    'sessions/    这个会话的 DSH 会话存档（第 0..N 轮）',
    'reset.json   reset 标记（count=' + plan.round.count + '）',
    '',
    '恢复：',
    `  1. memory/ 里的内容放回 ${target.conversationDir}`,
    `  2. sessions/ 里的每个目录放回 ${target.projectRoot}/`,
    `  3. reset.json 覆盖回 ${target.resetFile}（count=${plan.round.count}）`,
    '  4. 重启 qqbot，旧会话才会重新 resume。',
    '',
    '确认不需要之后，整个备份目录可以删掉。',
    '',
  ].join('\n');
}

/**
 * 备份并执行计划。
 *
 * 顺序是硬要求：**备份全部做完才开始删**。中途失败时备份已经是完整的，用户可以从
 * README 恢复；反过来（边删边备）就没有意义了。
 *
 * @param plan - {@link planForget} 的结果。
 * @param options - `{ backupRoot?, withDigest?, withMedia? }`。
 * @returns 备份路径、各项删除计数与新的 reset 代次。
 */
export async function applyForget(plan, options = {}) {
  const target = plan.target;
  const backupRoot = resolve(String(options.backupRoot ?? join(homedir(), 'qqbot-forget-backups')));
  const withDigest = options.withDigest === true;
  const withMedia = options.withMedia === true;
  const stamp = localStamp().replace(/[: ]/g, '-');
  // 同一秒里连跑两次时不覆盖上一份备份：加 -2 / -3 后缀。
  let backupDir = join(backupRoot, `${target.slug}-${stamp}`);
  for (let serial = 2; existsSync(backupDir); serial += 1) {
    backupDir = join(backupRoot, `${target.slug}-${stamp}-${serial}`);
  }
  mkdirSync(backupDir, { recursive: true });

  // ---- 1) 备份（全部做完才进入删除） --------------------------------------
  if (plan.conversation.exists) {
    cpSync(target.conversationDir, join(backupDir, 'memory'), { recursive: true });
  }
  if (plan.index.exists) {
    mkdirSync(join(backupDir, 'index'), { recursive: true });
    copyFileSync(target.indexPath, join(backupDir, 'index', 'INDEX.md'));
  }
  if (plan.stats.exists) {
    mkdirSync(join(backupDir, 'index'), { recursive: true });
    copyFileSync(target.statsPath, join(backupDir, 'index', 'memory.index.json'));
  }
  if (plan.round.exists) copyFileSync(target.resetFile, join(backupDir, 'reset.json'));
  if (plan.history.length > 0) {
    mkdirSync(join(backupDir, 'history'), { recursive: true });
    for (const item of plan.history) copyFileSync(item.path, join(backupDir, 'history', item.name));
  }
  for (const item of plan.generations) {
    cpSync(item.dir, join(backupDir, 'sessions', item.id), { recursive: true });
  }
  if (withDigest && plan.digest.exists) {
    cpSync(plan.digest.dir, join(backupDir, 'sessions', plan.digest.id), { recursive: true });
  }
  await writeTextAtomic(join(backupDir, 'README.txt'), restoreNote(plan, stamp));

  // ---- 2) 删长期记忆 -------------------------------------------------------
  if (plan.conversation.exists) rmSync(target.conversationDir, { recursive: true, force: true });

  // ---- 3) 清索引引用（坏 JSON 不覆盖） ------------------------------------
  let prunedIndex = 0;
  if (plan.index.removed > 0 && plan.index.next !== undefined) {
    await writeTextAtomic(target.indexPath, plan.index.next);
    prunedIndex = plan.index.removed;
  }
  let prunedStats = 0;
  if (plan.stats.removed > 0 && plan.stats.next !== undefined) {
    await writeTextAtomic(target.statsPath, plan.stats.next);
    prunedStats = plan.stats.removed;
  }

  // ---- 3.5) 删这个会话的 MEMORY.md 旧版本备份 -----------------------------
  const removedHistory = [];
  for (const item of plan.history) {
    rmSync(item.path, { force: true });
    removedHistory.push(item.name);
  }

  // ---- 4) 删会话存档 -------------------------------------------------------
  const removedSessions = [];
  for (const item of plan.generations) {
    rmSync(item.dir, { recursive: true, force: true });
    removedSessions.push(item.id);
  }
  let removedDigest = false;
  if (withDigest && plan.digest.exists) {
    rmSync(plan.digest.dir, { recursive: true, force: true });
    removedDigest = true;
  }

  // ---- 5) 可选的媒体缓存 ---------------------------------------------------
  const removedMedia = [];
  if (withMedia) {
    for (const item of plan.media) {
      if (!item.exists || item.referencedElsewhere) continue;
      rmSync(item.absolute, { force: true });
      removedMedia.push(item.ref);
    }
  }

  // ---- 6) 推进 reset 代次：旧会话不会再被 resume --------------------------
  const wroteRound = plan.round.exists || plan.generations.length > 0;
  if (wroteRound) {
    mkdirSync(dirname(target.resetFile), { recursive: true });
    await writeJsonAtomic(target.resetFile, { key: target.key, count: plan.nextRound });
  }

  return {
    backupDir,
    removedConversation: plan.conversation.exists,
    prunedIndex,
    prunedStats,
    removedHistory,
    removedSessions,
    removedDigest,
    removedMedia,
    wroteRound,
    nextRound: plan.nextRound,
  };
}
