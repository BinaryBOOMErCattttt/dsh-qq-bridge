/**
 * 把 `COGNITION.md` 里那些「以文件路径为键」的旧条目一次性迁到 `STICKERS.md`。
 *
 * 为什么要迁：认知库与表情包目录原本混在一个文件里，表情包条目拿
 * `.qq-media/<内容哈希>` 当键 —— 那是 LRU 缓存，迟早被淘汰，指向它的记忆就变成一条
 * 死链（`qq_save_sticker` 正是为修这个缺口而加的）。迁完之后两条硬规则成立：
 * `COGNITION.md` 里没有路径，`STICKERS.md` 的键一律是收藏后的文件名。
 *
 * 三条纪律（都对应一次「差点做错」）：
 *
 *   1. **默认 dry-run**：这是动记忆文件的事，先看报告再决定。`--apply` 才写。
 *   2. **写前备份**：原文件复制成 `<名>.bak-<时间戳>`，一份都不覆盖丢。
 *   3. **认不出就当「原图已过期」放进待办区**：不猜、不删。认图用 `perceptual.js` 的
 *      画面指纹（同一张表情包被 QQ 重新编码后字节不同，但指纹很近）—— 只在 `.qq-stickers/`
 *      里找，绝不拿 `.qq-media` 的路径去写目录。
 *
 * 用法：
 *   node scripts/migrate-cognition.mjs [--apply] [--json] [--cwd <目录>] [--memory <目录>] [--stickers <目录>]
 *
 * 也可以被 `scripts/ops.mjs` 直接 import（`planCognitionMigration` / `applyCognitionMigration`）。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/migrate-cognition
 */
import { readFile, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseCognition, appendStickerRow, stickerRow } from '../cognition.js';
import { hashDistance, perceptualHash } from '../perceptual.js';

/** 迁移报告里每条条目的处置：搬走的、留着的、丢掉的、要人看一眼的。 */
const ACTIONS = ['moved', 'kept', 'dropped', 'needs-human'];

/** 收藏目录里认得的图片扩展名（与出站那半边一致）。 */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/**
 * 画面比对的阈值：与 `repeatImageTolerance` 的默认值一致（实测同一张重新编码差 0%~2%，
 * 同一套画风只换字的差 16%~23%）。迁移是一次性动作，宁可漏认也不要把两张不同的图并成一条。
 */
const FINGERPRINT_TOLERANCE = 0.08;

/** 从一条旧条目里找出「以路径为键」的那个字段（按字段认，所以先去掉行首的 `- `）。 */
function pathFieldOf(entry) {
  return fieldsOf(entry).find((field) => /^\.qq-(?:media|stickers)\//.test(field));
}

/**
 * 去掉字段外侧成对的 markdown 包裹（反引号 / 直引号）。
 *
 * 为什么必须有这一步：摘要 Agent 与旧提示词写路径时习惯包一层反引号
 * （``- `.qq-media/d792c9e4….gif`｜画面｜含义``）。不剥掉的话路径字段认不出来，
 * 整条会被当成「普通文字条目」留在认知库里 —— 那不但是一条死链，还让迁移报告显示
 * 「搬走 0」，看起来像没事发生（本机真实事故：STICKERS.md 一直没被生成）。
 */
function unwrapField(field) {
  const match = /^([`"'])([\s\S]*)\1$/.exec(field);
  return match === null ? field : match[2].trim();
}

/** 条目去掉 `- ` 之后的字段数组（去空白、剥掉 markdown 包裹）。 */
function fieldsOf(entry) {
  return String(entry.line ?? '')
    .replace(/^[-*]\s+/, '')
    .split(/[｜|]/)
    .map((field) => unwrapField(field.trim()));
}

/**
 * 旧条目有两种写法，迁移必须都认：
 *
 *   1. **路径就是键**（`update-cognition` 旧示例的写法）：`.qq-media/x.gif｜画面｜含义｜场景`
 *      —— 第一段就是路径，整条都是图的意思，迁走之后**不应该**再留在认知库；
 *   2. **写法在前、路径混在中间**：`委屈猫｜画面｜.qq-media/x.gif｜含义` —— 那个词本身
 *      仍然是个说法，去掉路径后留在认知库。
 *
 * 把两种写法拆成同一个「表情包条目」形状，后面就不必再区分。
 * @param entry - {@link parseCognition} 的一条。
 * @param path - 这条条目里的路径字段。
 * @param resolvedPath - 迁移后的路径（认出了收藏图就是 `.qq-stickers/名字`）。
 * @returns `{ sticker, keepLine }`：`keepLine` 为空串表示整条迁走、不在认知库留空壳。
 */
function splitEntry(entry, path, resolvedPath) {
  const fields = fieldsOf(entry);
  const pathFirst = fields[0] === path;
  const rest = fields.filter((field) => field !== path);
  // 文件名是内容哈希（`.qq-media/8f3c1a….gif`）时，拿它当名字对谁都没用：
  // 退一步用画面描述当前几个字，至少让「未收藏」区里那一条读得懂。
  // 只取到第一个标点：`Q 版蓝毛女仆脸：蓝发盘发＋…` 当名字会得到半句被截断的废话，
  // 而这条名字是给人决定「还要不要收藏」看的。
  const fileBase = basename(resolvedPath, extname(resolvedPath));
  const described = String(rest[0] ?? '').split(/[：:，,；;。]/)[0].trim();
  const base = /^[0-9a-f]{8,}$/i.test(fileBase) ? (described.length > 0 ? described.slice(0, 12) : '表情包') : fileBase;
  if (pathFirst) {
    return {
      // 路径作键的老写法：段序是「路径｜画面｜含义｜场景｜日期」。`rest` 已经去掉了路径。
      sticker: {
        name: base,
        look: rest[0] ?? '',
        meaning: rest[1] ?? '',
        scene: rest[2] ?? '',
        confidence: entry.confidence,
      },
      keepLine: '',
    };
  }
  return {
    sticker: {
      name: entry.writeup === path ? base : entry.writeup,
      look: '',
      meaning: entry.meaning,
      scene: entry.usage,
      confidence: entry.confidence,
    },
    keepLine: rest.length >= 2 ? `- ${rest.join('｜')}` : '',
  };
}

/** 收藏目录里的图片文件（名字，不含目录）。 */
async function stickerFiles(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((name) => IMAGE_NAME.test(name) && !name.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * 在 `.qq-stickers/` 里找与某张 `.qq-media` 图**画面相同**的那一张。
 *
 * 为什么必须比对画面而不是字节：QQ 会把同一张表情包按发送者重新编码（实测同一张图三种
 * 字节形态、SSIM ≥ 0.985）。只比哈希的话，用户存过的那张永远认不出来。
 * 任何一步失败都返回 undefined（认不出就走「原图已过期」那条路）。
 */
async function findSameSticker(mediaPath, stickersDir, files) {
  let target;
  try {
    target = perceptualHash(await readFile(mediaPath));
  } catch {
    return undefined;
  }
  if (target === undefined) return undefined;
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of files) {
    let sketch;
    try {
      sketch = perceptualHash(await readFile(join(stickersDir, name)));
    } catch {
      continue;
    }
    if (sketch === undefined) continue;
    const distance = hashDistance(target, sketch);
    if (distance <= FINGERPRINT_TOLERANCE && distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best === undefined ? undefined : { name: best };
}

/**
 * 算出迁移计划（**只读**：不写任何文件）。
 *
 * @param {object} options
 * @param {string} options.cwd - 工作目录（记忆目录与表情包目录的基准）。
 * @param {string} [options.memoryDir] - 记忆目录，相对 cwd（默认 `.qq-memory`）。
 * @param {string} [options.stickerDir] - 表情包目录，相对 cwd（默认 `.qq-stickers`）。
 * @returns 计划：搬几条、留几条、丢几条、哪些要人看一眼，以及两份文件的新内容。
 */
export async function planCognitionMigration({ cwd, memoryDir = '.qq-memory', stickerDir = '.qq-stickers' } = {}) {
  const root = resolve(cwd ?? process.cwd());
  const memoryRoot = resolve(root, memoryDir);
  const stickerRoot = resolve(root, stickerDir);
  const cognitionPath = join(memoryRoot, 'COGNITION.md');
  const stickersPath = join(memoryRoot, 'STICKERS.md');
  const cognitionText = existsSync(cognitionPath) ? await readFile(cognitionPath, 'utf8') : undefined;
  const stickersText = existsSync(stickersPath) ? await readFile(stickersPath, 'utf8') : '';
  const plan = {
    schema: 1,
    action: 'migrate cognition',
    cwd: root,
    memory: { dir: memoryDir, cognition: existsSync(cognitionPath), stickers: existsSync(stickersPath) },
    entries: [],
    stats: { total: 0, moved: 0, kept: 0, dropped: 0, needsHuman: 0 },
    // 两份文件的新内容：dry-run 时也能拿去比对；apply 时才落盘。
    next: { cognition: cognitionText ?? '', stickers: stickersText },
    changes: [],
  };
  if (cognitionText === undefined) {
    plan.note = `没有 ${memoryDir}/COGNITION.md，没什么可迁的`;
    return plan;
  }
  const parsed = parseCognition(cognitionText);
  plan.entries = parsed.entries.map((entry) => ({
    writeup: entry.writeup,
    section: entry.section,
    meaning: entry.meaning,
    action: 'kept',
    line: entry.line,
  }));
  plan.stats.total = parsed.entries.length;
  plan.changes = [...parsed.warnings];

  const files = await stickerFiles(stickerRoot);
  let stickers = stickersText;
  // 与 `parsed.entries` **逐位对齐**的「这条留下什么」：`undefined` = 整条迁走、原文那行删掉。
  // 不能只用「保留下来的行」这个数组 —— 文件里有 `parseCognition` 跳过的碎条目（少一段的
  // 手写行），拿保留下来的行去逐行回填会整体错位，把后面的条目挤丢（本机真实事故：
  // 「森美奈美」「洛天依」两条差点被一次迁移吃掉）。
  const keptByEntry = new Array(parsed.entries.length);
  // 逐条重写 COGNITION.md：留着的行原样写回，带路径的行去掉路径字段（写回时若已没有
  // 有效含义就整条丢掉 —— 空壳条目只会让提示词里多一行废话）。
  for (const [index, entry] of parsed.entries.entries()) {
    const report = plan.entries[index];
    const path = pathFieldOf(entry);
    if (path === undefined) {
      keptByEntry[index] = entry.line;
      plan.stats.kept += 1;
      continue;
    }
    report.path = path;
    let resolvedPath = path;
    if (path.startsWith('.qq-stickers/') && files.includes(basename(path))) {
      // 已经是收藏路径：原样视为「已收藏」。
    } else if (path.startsWith('.qq-media/')) {
      const found = await findSameSticker(join(root, path), stickerRoot, files);
      if (found !== undefined) resolvedPath = `.qq-stickers/${found.name}`;
    }
    const collected = resolvedPath.startsWith('.qq-stickers/') && files.includes(basename(resolvedPath));
    const { sticker, keepLine } = splitEntry(entry, path, resolvedPath);
    if (!collected) {
      // 「原图已过期」要写在条目上：否则以后看到一条只有路径的待办，不知道那张图还在不在。
      sticker.scene = [sticker.scene, '原图已过期，找到后先收藏再补含义'].filter((part) => part.length > 0).join('；');
    }
    const row = appendStickerRow(stickers, {
      name: sticker.name,
      look: sticker.look,
      meaning: sticker.meaning,
      scene: sticker.scene,
      path: resolvedPath,
      date: entry.date,
      confidence: collected ? sticker.confidence : '存疑',
    }, { collected });
    stickers = row.text;
    // 认不出收藏图时**不删**这条记忆：它可能还有用，标注「原图已过期」放进待办区。
    report.action = collected ? 'moved' : 'needs-human';
    report.sticker = resolvedPath;
    if (collected) {
      plan.stats.moved += 1;
      plan.changes.push(`第 ${index + 1} 条迁到 STICKERS.md：${sticker.name} → ${resolvedPath}`);
    } else {
      report.reason = '在 .qq-stickers 里找不到同一张图（原图可能已过期），已放进「未收藏」区';
      plan.stats.needsHuman += 1;
      plan.changes.push(`第 ${index + 1} 条认不出对应的收藏图：${sticker.name || path}`);
    }
    // 只有「写法在前」的那种条目在认知库里还有内容；路径作键的老条目整条迁走。
    if (keepLine.length > 0) {
      keptByEntry[index] = keepLine;
      plan.stats.kept += 1;
    } else if (!collected) {
      plan.stats.dropped += 1;
      report.action = 'needs-human';
    }
    continue;
  }
  // 原文件有二级标题时就按原结构保留，否则给一个最小骨架。
  const hasSections = /^##\s/m.test(cognitionText);
  plan.next.cognition = hasSections
    ? normalizeCognition(cognitionText, parsed.entries, keptByEntry)
    : `# 公共认知（语言梗 / 黑话 / 缩写 / 谐音）\n\n${keptByEntry.filter((line) => line !== undefined).join('\n')}\n`;
  plan.next.stickers = stickers;
  return plan;
}

/**
 * 按原文件的分节结构重排保留的条目（标题、说明文字都留着，只替换条目行）。
 *
 * 为什么不是直接拼一个新文件：`COGNITION.md` 里有摘要 Agent 手写的分节标题与说明，
 * 迁移只该动条目，不该顺手把结构冲平。
 *
 * 逐行替换的依据是**原文那一行本身**（`entry.line`），不是「第几个 `- ` 行」：
 * `parseCognition` 会跳过字段不够的碎条目，按序号回填会让它们与后面的条目错位 ——
 * 被跳过的行必须原样留在原处，它旁边那几条才不会被挪走或吃掉。
 *
 * @param text - 原文件内容。
 * @param entries - {@link parseCognition} 的 `entries`（与原文同序）。
 * @param keptByEntry - 与 `entries` 逐位对齐的替换行；`undefined` 表示整条删除。
 */
function normalizeCognition(text, entries, keptByEntry) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let at = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed) && at < entries.length && trimmed === entries[at].line) {
      // 认出了这是「解析到的那一条」：按计划替换，或整条删掉（它已经迁进 STICKERS.md）。
      const replacement = keptByEntry[at];
      if (replacement !== undefined) out.push(replacement);
      at += 1;
      continue;
    }
    // 其余行（标题、说明、以及解析器跳过的碎条目）原样留着。
    out.push(line);
  }
  // 理论上走不到这里；真剩了说明解析结果与原文对不上，宁可补到末尾，也不静默丢条目。
  for (let index = at; index < entries.length; index += 1) {
    const replacement = keptByEntry[index];
    if (replacement !== undefined) out.push(replacement);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 执行计划（**写文件**）：先备份，再写两份文件。
 *
 * 备份在同一目录下（`COGNITION.md.bak-<时间戳>`），与 `napcat.js` / `desktop.js` 的约定一致：
 * 用户想手工比对或回滚时，东西就在旁边。
 *
 * @param {object} plan - {@link planCognitionMigration} 的结果。
 * @returns 执行结果：`{ ok, backups, written }`。
 */
export async function applyCognitionMigration(plan) {
  if (plan === undefined || plan.next === undefined) return { ok: false, error: 'no migration plan' };
  const memoryRoot = resolve(plan.cwd, plan.memory.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  const written = [];
  const targets = [
    { name: 'COGNITION.md', text: plan.next.cognition },
    { name: 'STICKERS.md', text: plan.next.stickers },
  ];
  for (const target of targets) {
    const absolute = join(memoryRoot, target.name);
    if (existsSync(absolute)) {
      const backup = `${absolute}.bak-${stamp}`;
      await copyFile(absolute, backup);
      backups.push(backup);
    }
    await import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(memoryRoot, { recursive: true }).then(() => writeFile(absolute, target.text, 'utf8')));
    written.push(absolute);
  }
  return { ok: true, backups, written };
}

// ---- CLI -------------------------------------------------------------------

/**
 * 命令行入口：`--dry-run` 默认，`--apply` 才写。
 *
 * 输出分两路：`--json` 时 stdout **只有**一个 JSON 对象（agent 要能直接 parse），
 * 人读的说明一律走 stderr。
 */
async function main(argv) {
  const args = new Set(argv.filter((arg) => arg.startsWith('--')));
  const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
  };
  const apply = args.has('--apply');
  const json = args.has('--json');
  const cwd = resolve(value('cwd', process.cwd()));
  const memoryDir = value('memory', '.qq-memory');
  const stickerDir = value('stickers', '.qq-stickers');
  const note = (line) => process.stderr.write(`${line}\n`);
  try {
    const plan = await planCognitionMigration({ cwd, memoryDir, stickerDir });
    let applied;
    if (apply && plan.next !== undefined) applied = await applyCognitionMigration(plan);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ...plan, applied: applied ?? { ok: true, dryRun: true } }, null, 2)}\n`);
    } else {
      note(`迁移计划（${apply ? '已执行' : 'dry-run，加 --apply 才写'}）`);
      note(`  共 ${plan.stats.total} 条：搬走 ${plan.stats.moved} · 留着 ${plan.stats.kept} · 丢掉 ${plan.stats.dropped} · 要人看一眼 ${plan.stats.needsHuman}`);
      for (const change of plan.changes.slice(0, 40)) note(`  - ${change}`);
      if (applied?.backups?.length > 0) for (const backup of applied.backups) note(`  备份：${backup}`);
      if (plan.note !== undefined) note(plan.note);
    }
    // 退出码：0 = 没什么要人处理的；2 = 有认不出来的条目（需要人看一眼）。
    return plan.stats.needsHuman > 0 ? 2 : 0;
  } catch (error) {
    if (json) process.stdout.write(`${JSON.stringify({ schema: 1, ok: false, action: 'migrate cognition', error: error?.message ?? String(error) })}\n`);
    else note(`迁移失败：${error?.message ?? error}`);
    return 3;
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  // eslint-disable-next-line no-console -- CLI 的退出码是接口的一部分
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
