/**
 * 认知库与表情包目录的**纯解析**：两种「学来的东西」，两种身份，两个文件。
 *
 * 为什么要把它们分开（这是本模块存在的全部理由）：
 *
 *   - `COGNITION.md` 装的是**语言**：梗、黑话、缩写、谐音。它的键是**文字写法**
 *     （含变体），所以 `qq_memory search 蚌埠` 能命中。它不会过期。
 *   - `STICKERS.md` 装的是**图**：一张表情包的键是**收藏后的文件名**
 *     （`.qq-stickers/委屈猫.gif`），而不是 `.qq-media/<内容哈希>` —— 后者是 LRU 缓存，
 *     迟早被淘汰，指向它的记忆条目只会变成一条死链（真实事故：机器人说「存好了」，
 *     过几天那张图没了）。
 *
 * 两者混在一个文件里时，一个 skill 要管两件事、一个索引要装两种键，而它们的失效方式
 * 完全不同。所以这里只做**解析与渲染**，不碰磁盘、不碰运行时状态：
 *   - 解析结果给 `memory.js` 读文件后调用；
 *   - 渲染结果拼进提示词（表情包目录 + 热梗段）。
 *
 * 格式故意选「一行一条、全角竖线分隔」：没有 YAML 依赖，坏了也只坏那一条，
 * 而且摘要 Agent 手写时不容易写错。
 *
 * @module @qqbot/dsh-plugin-qq/cognition
 */

/** `COGNITION.md` 里认得的两个二级标题；其余节的条目照样解析，只是不区分。 */
const COGNITION_SECTIONS = ['黑话与缩写', '谐音与变体', '其它'];

/** `STICKERS.md` 里认得的两个二级标题：只有「已收藏」会进提示词。 */
const STICKER_COLLECTED = '已收藏';
const STICKER_PENDING = '未收藏';

/** 「置信」只有两种取值：确认过、存疑；缺省按确认算（手写条目很少会写这个）。 */
const CONFIRMED = '确认';
const DOUBTFUL = '存疑';

/** 日期形状：`2026-10-12`。识别它，是为了把「首见日期」与可选的「来源」分开。 */

/**
 * 把一行 `- a｜b｜c` 切成字段（全角竖线优先，半角也认）。
 *
 * 为什么两种都认：摘要 Agent 偶尔会顺手打半角，而半角在中文输入法下并不罕见；
 * 只认全角会让那一条静默变成「一个字段」，然后在提示词里显示成一句莫名其妙的长话。
 * @param line - 去掉 `- ` 之后的一行。
 * @returns 去空白后的字段数组。
 */
export function splitFields(line) {
  return String(line ?? '')
    .split(/[｜|]/)
    .map((field) => field.trim());
}

/**
 * 把标题行（`## 已收藏`）归一化：去掉 `##`、序号、空白。
 * @param line - 原始行。
 * @returns 节名；不是标题行时为空串。
 */
function sectionName(line) {
  const match = /^#{2,3}\s*(.+?)\s*$/.exec(String(line ?? ''));
  return match === null ? '' : match[1].trim();
}

/**
 * 从字段里挑出「首见日期」与「置信」。
 *
 * 两条都**只按内容认、不按位置认**：格式说明里它们排在最后，但手写时经常漏掉来源，
 * 于是日期会往前挪一格。按内容认，写歪一格也不会把日期当成「怎么用」。
 * @param fields - {@link splitFields} 的结果。
 * @returns `{ date, confidence, rest }`：`rest` 是剩下的普通字段。
 */
function takeMeta(fields) {
  let date = '';
  let confidence = '';
  const rest = [];
  for (const field of fields) {
    // 「2026-10-12」与「首见 2026-10-12」都算日期：格式说明里写的是后者，但手写时
    // 两种都有人写。只在前面的字段里还没认到日期时生效，免得把含义里的年份吃掉。
    const dated = /^(?:首见\s*)?(\d{4}-\d{2}-\d{2})$/.exec(field);
    if (date.length === 0 && dated !== null) {
      date = dated[1];
      continue;
    }
    const mark = /^置信\s*[:：]\s*(.+)$/.exec(field);
    if (mark !== null) {
      confidence = mark[1].trim() === DOUBTFUL ? DOUBTFUL : CONFIRMED;
      continue;
    }
    if (field === DOUBTFUL || field === CONFIRMED) {
      confidence = field;
      continue;
    }
    rest.push(field);
  }
  return { date, confidence, rest };
}

/**
 * 解析 `COGNITION.md`。
 *
 * 条目格式：`写法（变体：A / B）｜一句话意思｜怎么用｜来源（可选）｜首见日期｜置信：确认`。
 * 少于两个字段的行当作「还不会解析」丢掉并记进 `warnings` —— 宁可少一条，也不要把
 * 半行字塞进提示词（模型会照着那半行编）。
 *
 * @param {string} markdown - 文件内容（可以不存在 → 传空串）。
 * @returns {{ entries: object[], warnings: string[] }} 条目按文件顺序（旧 → 新）。
 *   每条：`{ section, writeup, variants, meaning, usage, source, date, confidence, line }`。
 */
export function parseCognition(markdown) {
  const entries = [];
  const warnings = [];
  let section = COGNITION_SECTIONS[0];
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      const name = sectionName(line);
      if (name.length > 0) section = name;
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item === null) continue; // 段落说明、注释之类的非条目行：忽略，不算错。
    const fields = takeMeta(splitFields(item[1]));
    if (fields.rest.length < 2) {
      warnings.push(`COGNITION.md 第 ${index + 1} 行少于两段，跳过：${line.slice(0, 60)}`);
      continue;
    }
    // 第一段是「写法（变体：…）」：变体写进同一段里，是为了 `search 蚌埠` 能命中
    // 而不用为每个变体复制一条（复制出来的条目迟早互相矛盾）。
    const head = fields.rest[0];
    const variantMatch = /^(.*?)[（(]\s*变体\s*[:：]\s*(.+?)\s*[)）]\s*$/.exec(head);
    const writeup = (variantMatch === null ? head : variantMatch[1]).trim();
    const variants = variantMatch === null
      ? []
      : variantMatch[2].split(/[\/／、,，]/).map((item) => item.trim()).filter((item) => item.length > 0);
    if (writeup.length === 0) {
      warnings.push(`COGNITION.md 第 ${index + 1} 行没有写法，跳过`);
      continue;
    }
    entries.push({
      section,
      writeup,
      variants,
      meaning: fields.rest[1] ?? '',
      usage: fields.rest[2] ?? '',
      source: fields.rest[3] ?? '',
      date: fields.date,
      confidence: fields.confidence.length > 0 ? fields.confidence : CONFIRMED,
      line,
    });
  }
  return { entries, warnings };
}

/**
 * 每轮注入的「热梗段」：最近 `limit` 条**确认过**的条目。
 *
 * 为什么只取文件末尾：写入是追加式的，最新学到的梗在最后；而聊天里「刚学到的」
 * 恰恰最可能马上又用到。这也是为什么它不能替代 `qq_memory search` —— 更早的条目
 * 仍然在文件里，要查的时候查得到。
 *
 * 「置信：存疑」刻意不进：存疑的条目正是那些「大概是这个意思」的猜测，每轮摆在
 * 提示词里会让模型把猜测当事实用。
 *
 * @param {object[]} entries - {@link parseCognition} 的 `entries`。
 * @param {object} [options] - `limit`（默认 15 条）、`maxChars`（默认 1200 字）。
 * @returns {string[]} 形如 `典 —— 讽刺「经典操作」` 的行；没有条目时为空数组。
 */
export function hotCognitionLines(entries, { limit = 15, maxChars = 1200 } = {}) {
  const confirmed = (entries ?? []).filter((entry) => entry.confidence !== DOUBTFUL && entry.meaning.length > 0);
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  // `cap === 0` 时直接空：`slice(-0)` 是「整个数组」，那是这里最容易踩的坑。
  const picked = cap === 0 ? [] : confirmed.slice(-cap);
  const lines = [];
  let used = 0;
  for (const entry of picked) {
    const variants = entry.variants.length > 0 ? `（变体：${entry.variants.join(' / ')}）` : '';
    const line = `${entry.writeup}${variants} —— ${entry.meaning}`;
    // 超预算就停：宁可少几条，也不要把最后一条截成半句（半句会被模型当成完整意思）。
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/**
 * 解析 `STICKERS.md`。
 *
 * 「已收藏」的条目有完整七段；「未收藏」只是待办（`名字｜路径｜含义待确认`），
 * **不进提示词**也不参与选择 —— 它提醒的是「这张图还没存，先存再补含义」。
 *
 * @param {string} markdown - 文件内容。
 * @returns {{ collected: object[], pending: object[], warnings: string[] }}。
 *   collected 每条：`{ name, look, meaning, scene, path, source, date, confidence, line }`。
 *   pending 每条：`{ name, path, note, line }`。
 */
export function parseStickerCatalog(markdown) {
  const collected = [];
  const pending = [];
  const warnings = [];
  let section = STICKER_COLLECTED;
  for (const [index, raw] of String(markdown ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      const name = sectionName(line);
      if (name.length > 0) section = name;
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item === null) continue;
    const fields = splitFields(item[1]);
    const name = fields[0] ?? '';
    // 路径的识别不按位置：待办条目只有「名字｜路径｜备注」，而收藏条目中间有画面/含义/
    // 场景。谁身上带 `.qq-stickers/` 或 `.qq-media/` 前缀，谁就是路径。
    const pathAt = fields.findIndex((field) => /\.qq-(?:stickers|media)\//.test(field));
    if (name.length === 0) {
      warnings.push(`STICKERS.md 第 ${index + 1} 行没有名字，跳过`);
      continue;
    }
    // 标题里常带括号说明（`## 未收藏（先收藏再补含义）`），所以按前缀认区。
    if (section.startsWith(STICKER_PENDING)) {
      pending.push({
        name,
        path: pathAt >= 0 ? fields[pathAt] : '',
        note: fields.filter((_, at) => at !== 0 && at !== pathAt).join('｜'),
        line,
      });
      continue;
    }
    const meta = takeMeta(fields.filter((_, at) => at !== 0 && at !== pathAt));
    if (meta.rest.length < 2 || pathAt < 0) {
      // 收藏区里缺路径或缺含义：这条选不出来，也发不出去，只当待办。
      warnings.push(`STICKERS.md 第 ${index + 1} 行不完整（缺路径或含义），跳过：${line.slice(0, 60)}`);
      continue;
    }
    collected.push({
      name,
      look: meta.rest[0] ?? '',
      meaning: meta.rest[1] ?? '',
      scene: meta.rest[2] ?? '',
      path: fields[pathAt],
      source: meta.rest[3] ?? '',
      date: meta.date,
      confidence: meta.confidence.length > 0 ? meta.confidence : CONFIRMED,
      line,
    });
  }
  return { collected, pending, warnings };
}

/**
 * 提示词里的表情包目录：**名字（含义）**，不是裸文件名。
 *
 * 这就是「表情包优先」能不能落地的那一步：模型看 `委屈猫（委屈、求安慰）` 时可以直接
 * 判断该不该发；看 `.qq-stickers/8f3c1a.gif` 时只能猜或者先 `read_image` —— 而猜错的
 * 代价是群里收到一张莫名其妙的表情。
 *
 * @param {object[]} collected - {@link parseStickerCatalog} 的 `collected`。
 * @param {object} [options] - `max`（默认 40 条，与旧 `STICKER_PROMPT_MAX` 一致）。
 * @returns {string[]} 形如 `委屈猫（委屈、求安慰）`；没有条目时为空数组。
 */
export function stickerCatalogLines(collected, { max = 40 } = {}) {
  return (collected ?? [])
    .slice(0, Math.max(0, Math.floor(Number(max) || 0)))
    .map((entry) => (entry.meaning.length > 0 ? `${entry.name}（${entry.meaning}）` : entry.name));
}

/**
 * 一条新表情包要追加进 `STICKERS.md` 的那一行（**纯函数**，不碰磁盘）。
 *
 * 为什么写这一行而不是只存文件：只存文件的话，模型下一轮看到的还是一串文件名，
 * 而「含义」是它自己刚判断出来的 —— 不写下来，下次还得再 `read_image` 猜一遍。
 *
 * @param {object} entry - `{ name, meaning, scene, path, date, look?, confidence? }`。
 * @returns 一条 `- 名字｜画面｜含义｜适用场景｜路径｜日期｜置信：…`。
 */
export function stickerRow(entry) {
  const fields = [
    entry.name,
    entry.look ?? '',
    entry.meaning ?? '',
    entry.scene ?? '',
    entry.path,
    entry.date ?? '',
    `置信：${entry.confidence === DOUBTFUL ? DOUBTFUL : CONFIRMED}`,
  ];
  return `- ${fields.join('｜')}`;
}

/**
 * 把一行追加到 `STICKERS.md` 的对应区（文件不存在时连标题一起给出来）。
 *
 * 分「已收藏 / 未收藏」两条路：没有含义的条目进待办区，提示它之后补一句 ——
 * 直接塞进收藏区会让提示词里出现一条只有名字的条目，模型照样选不出该不该发。
 *
 * @param {string} markdown - 现有内容（不存在时传空串）。
 * @param {object} entry - 见 {@link stickerRow}。
 * @param {object} [options] - `collected`（默认 true = 写进已收藏区）。
 * @returns {{ text: string, section: string }} 新文件内容与实际写入的区名。
 */
export function appendStickerRow(markdown, entry, { collected = true } = {}) {
  const row = stickerRow(entry);
  const target = collected ? STICKER_COLLECTED : STICKER_PENDING;
  const body = String(markdown ?? '');
  if (body.trim().length === 0) {
    return {
      text: `# 表情包目录\n\n## ${STICKER_COLLECTED}\n${collected ? `${row}\n` : ''}\n## ${STICKER_PENDING}\n${collected ? '' : `${row}\n`}`,
      section: target,
    };
  }
  const lines = body.split(/\r?\n/);
  const heading = `## ${target}`;
  // 标题可能带着括号说明（`## 未收藏（…）`），所以按前缀找。
  const start = lines.findIndex((line) => line.trim() === heading || line.trim().startsWith(`${heading}（`) || line.trim().startsWith(`${heading}(`));
  if (start < 0) {
    // 文件在、但没有这个区（旧部署 / 手写漏了）：补一个区，不要覆盖原有内容。
    const suffix = body.endsWith('\n') ? '' : '\n';
    return { text: `${body}${suffix}\n${heading}\n${row}\n`, section: target };
  }
  // 插到该区**最后一条**后面；节里还没有条目就是标题行之后。
  let insertAt = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('#')) break;
    if (/^[-*]\s+/.test(line)) insertAt = index + 1;
  }
  lines.splice(insertAt, 0, row);
  return { text: `${lines.join('\n')}\n`, section: target };
}

/**
 * 找出 `COGNITION.md` 里那些「写成了文件路径」的条目（迁移与体检用）。
 *
 * 这是 §9 的两条硬规则之一：认知库只装**文字**，路径指向的是会被淘汰的缓存。
 * 迁移脚本用它列清单，`ops doctor` 也可以拿它当一条 findings。
 * @param {object[]} entries - {@link parseCognition} 的 `entries`。
 * @returns 形如 `{ line, writeup, path }` 的数组。
 */
export function cognitionPathViolations(entries) {
  const violations = [];
  for (const entry of entries ?? []) {
    // 路径前面可能是空格，也可能是全角竖线（认知条目就是竖线分段的），所以只认前缀本身。
    const match = /(\.qq-(?:media|stickers)\/[^\s｜|）)]+)/.exec(entry.line ?? '');
    if (match !== null) violations.push({ line: entry.line, writeup: entry.writeup, path: match[1] });
  }
  return violations;
}
