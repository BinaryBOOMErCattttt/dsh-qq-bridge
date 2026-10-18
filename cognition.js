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

/** `COGNITION.md` 里认得的二级标题；其余节的条目照样解析，只是不区分。 */
const COGNITION_SECTIONS = ['黑话与缩写', '谐音与变体', '专名与作品', '其它'];

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
 * 「最近」按**首见日期**算，不按它在文件里排第几：条目顺序会被人整理、被合并分节
 * 动过，拿文件位置当时间轴的话，一次排版就等于悄悄换了它每轮记得什么（真实事故：
 * 合并两个同名标题时，谁在最后谁就还在「最近 15 条」里）。没有日期的条目算最旧 ——
 * 手写条目常常不写日期，不能让它挤掉有日期的；同日期按文件顺序、靠后的算更新。
 *
 * 这也是为什么它不能替代 `qq_memory search` —— 更早的条目仍然在文件里，要查的时候查得到。
 *
 * 「置信：存疑」刻意不进：存疑的条目正是那些「大概是这个意思」的猜测，每轮摆在
 * 提示词里会让模型把猜测当事实用。
 *
 * @param {object[]} entries - {@link parseCognition} 的 `entries`。
 * @param {object} [options] - `limit`（默认 15 条）、`maxChars`（默认 1200 字）。
 * @returns {string[]} 形如 `典 —— 讽刺「经典操作」` 的行；没有条目时为空数组。
 */
export function hotCognitionLines(entries, { limit = 15, maxChars = 1200 } = {}) {
  const confirmed = (entries ?? [])
    .filter((entry) => entry.confidence !== DOUBTFUL && entry.meaning.length > 0)
    .map((entry, index) => ({ entry, index }));
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const byRecency = confirmed.slice().sort((a, b) => {
    const da = a.entry.date ?? '';
    const db = b.entry.date ?? '';
    if (da !== db) return da < db ? 1 : -1;
    return a.index - b.index;
  });
  // `cap === 0` 时要显式给空数组：`slice(0, -0)` 与 `slice(-0)` 都容易在这里出错。
  // 选完之后按文件顺序渲染：提示词里读起来仍是「先学的在前」，顺序稳定也好核对。
  const picked = (cap === 0 ? [] : byRecency.slice(0, cap))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.entry);
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
 * 提示词里的表情包目录：**名字（含义）→ 完整路径**。
 *
 * 这就是「表情包优先」能不能落地的那一步：模型看 `委屈猫（委屈、求安慰）` 时可以直接
 * 判断该不该发；看 `.qq-stickers/8f3c1a.gif` 时只能猜或者先 `read_image` —— 而猜错的
 * 代价是群里收到一张莫名其妙的表情。
 *
 * 路径必须**原样**给出来（而不只是名字 + 「自己补扩展名」）：表情包目录里 .jpg / .gif
 * 混着放，模型只看到名字时只能猜一个扩展名，猜错就是「not a local file」—— 群里收到
 * 一句「那张表情我这儿没有」，而那些图其实好好躺在目录里（真实事故：敲盆.gif 被写成
 * 敲盆.jpg）。给了完整路径，模型抄过去就行，不用赌。
 *
 * @param {object[]} collected - {@link parseStickerCatalog} 的 `collected`。
 * @param {object} [options] - `max`（默认 40 条，与旧 `STICKER_PROMPT_MAX` 一致）。
 * @returns {string[]} 形如 `委屈猫（委屈、求安慰）→ .qq-stickers/委屈猫.gif`；没有条目时为空数组。
 */
export function stickerCatalogLines(collected, { max = 40 } = {}) {
  return (collected ?? [])
    .slice(0, Math.max(0, Math.floor(Number(max) || 0)))
    .map((entry) => {
      const label = entry.meaning.length > 0 ? `${entry.name}（${entry.meaning}）` : entry.name;
      // 老条目可能没有路径（解析层会挡掉，这里只是不拼出 `→ undefined`）。
      return entry.path.length > 0 ? `${label} → ${entry.path}` : label;
    });
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

/** `type`（分诊时说的类型）→ 二级标题。认不出来的走「黑话与缩写」，不新造节。 */
const SECTION_BY_TYPE = {
  缩写: '黑话与缩写',
  简称: '黑话与缩写',
  黑话: '黑话与缩写',
  谐音: '谐音与变体',
  变体: '谐音与变体',
  专名: '专名与作品',
  作品: '专名与作品',
  角色: '专名与作品',
  选手: '专名与作品',
  主播: '专名与作品',
  其它: '其它',
  其他: '其它',
};

/**
 * 把一个「类型」映射成 `COGNITION.md` 的二级标题。
 *
 * 为什么要这一步：分类不该由模型在 append 时自己决定（它只会照抄上一个标题），
 * 也不该在写完之后靠人整理 —— 让工具在落盘时按类型归位，才有稳定的分节。
 * @param type - 例如 `谐音` / `专名` / `缩写`。
 * @returns 二级标题名（不含 `## `）。
 */
export function sectionForType(type) {
  const key = String(type ?? '').trim();
  if (key.length === 0) return COGNITION_SECTIONS[0];
  return SECTION_BY_TYPE[key] ?? SECTION_BY_TYPE[key.replace(/[与和]/g, '').slice(0, 2)] ?? COGNITION_SECTIONS[0];
}

/** 比较用的键：反引号与空白都不算区别（模型常把名字包一层反引号）。 */
function compareKey(value) {
  return String(value ?? '').replace(/[`\s]/g, '').trim();
}

/** 一条认知条目渲染成文件里的那一行。 */
export function cognitionRow(entry) {
  // 变体既接受数组，也接受「A / B」这样的字符串：工具层拆过一次，直接调用的人可能没拆。
  const variants = Array.isArray(entry?.variants)
    ? entry.variants
    : String(entry?.variants ?? '').split(/[\/／、,，]/);
  const picked = variants.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
  const writeup = `${String(entry?.writeup ?? '').trim()}${picked.length > 0 ? `（变体：${picked.join(' / ')}）` : ''}`;
  const meaning = String(entry?.meaning ?? '').trim();
  if (writeup.length === 0) throw new Error('cognition row needs a writeup (the word itself)');
  // 没有含义的认知条目解析器会整个丢掉（`rest.length < 2`），所以这里就拒绝，
  // 别让工具「成功」写进一条永远不会被读到的行。
  if (meaning.length === 0) throw new Error('cognition row needs a meaning (one sentence)');
  const tail = [entry.usage, entry.source, entry.date]
    .map((field) => String(field ?? '').trim())
    .filter((field) => field.length > 0);
  const confidence = entry.confidence === DOUBTFUL ? DOUBTFUL : CONFIRMED;
  return `- ${[writeup, meaning, ...tail, `置信：${confidence}`].join('｜')}`;
}

/** 删掉文件里满足条件的行（保留其余内容与顺序）。 */
function dropLines(markdown, test) {
  return String(markdown ?? '')
    .split(/\r?\n/)
    .filter((line) => !test(line))
    .join('\n');
}

/** 在一节末尾插入一行；节不存在就补一个节（不覆盖原内容）。 */
function insertIntoSection(markdown, section, row) {
  const body = String(markdown ?? '');
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => sectionName(line) === section);
  if (start < 0) {
    const suffix = body.length === 0 ? '' : body.endsWith('\n') ? '' : '\n';
    return `${body}${suffix}${body.length === 0 ? '' : '\n'}## ${section}\n${row}\n`;
  }
  let insertAt = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('#')) break;
    if (/^[-*]\s+/.test(line)) insertAt = index + 1;
  }
  lines.splice(insertAt, 0, row);
  return `${lines.join('\n')}\n`;
}

/**
 * 写入或更新一条认知条目（按写法匹配，不再让模型整份重写 markdown）。
 *
 * 三条规则：
 *   1. 同「写法」已经存在 → **原地替换**那一行（位置不变，其它条目一字不动）；
 *   2. 不存在 → 按 `type` 归到对应的二级标题下，没有那个节就补一个；
 *   3. 什么都不猜：没有含义直接报错，不写一条解析器会丢掉的空条目。
 *
 * @param markdown - 现有文件内容（不存在时传空串）。
 * @param entry - `{ writeup, meaning, usage?, source?, date?, confidence?, variants?, type? }`。
 * @param options.section - 显式指定二级标题（优先于 `type`）。
 * @returns `{ text, section, replaced }`。
 */
export function upsertCognitionRow(markdown, entry, { section } = {}) {
  const row = cognitionRow(entry);
  const key = compareKey(entry?.writeup);
  const body = String(markdown ?? '');
  const { entries } = parseCognition(body);
  const existing = entries.find((item) => compareKey(item.writeup) === key);
  if (existing !== undefined) {
    const lines = body.split(/\r?\n/);
    const at = lines.findIndex((line) => line.trim() === existing.line);
    if (at >= 0) {
      lines[at] = row;
      return { text: `${lines.join('\n')}\n`, section: existing.section, replaced: true };
    }
  }
  const target = section ?? sectionForType(entry?.type);
  return { text: insertIntoSection(body, target, row), section: target, replaced: false };
}

/**
 * 删掉一条认知条目（按写法匹配）。只删这一行，其余原样保留。
 * @returns `{ text, removed }`。
 */
export function removeCognitionRow(markdown, writeup) {
  const key = compareKey(writeup);
  const { entries } = parseCognition(markdown);
  const hit = entries.find((item) => compareKey(item.writeup) === key);
  if (hit === undefined) return { text: String(markdown ?? ''), removed: false };
  return { text: dropLines(markdown, (line) => line.trim() === hit.line), removed: true };
}

/**
 * 写入或更新一条表情包目录条目（按名字匹配）。
 *
 * 与 `appendStickerRow` 的区别：同名条目会被**替换**而不是再追加一条（否则目录里
 * 会出现两张同名、含义不同的记录，模型只能随机挑一个）。替换时先删旧的再插到目标区，
 * 所以「未收藏 → 补了含义」会自然升进「已收藏」。
 *
 * @param markdown - 现有内容。
 * @param entry - 见 {@link stickerRow}。
 * @param options.collected - 是否进「已收藏」区（默认按有没有含义判断）。
 * @returns `{ text, section, replaced }`。
 */
export function upsertStickerRow(markdown, entry, { collected } = {}) {
  const nameKey = compareKey(entry?.name);
  if (nameKey.length === 0) throw new Error('sticker row needs a name');
  const hasMeaning = String(entry?.meaning ?? '').trim().length > 0;
  const target = collected ?? hasMeaning;
  const parsed = parseStickerCatalog(markdown);
  const existing = [...parsed.collected, ...parsed.pending].find((row) => compareKey(row.name) === nameKey);
  let body = String(markdown ?? '');
  if (existing !== undefined) body = dropLines(body, (line) => line.trim() === existing.line);
  const { text } = appendStickerRow(body, entry, { collected: target });
  return { text, section: target ? STICKER_COLLECTED : STICKER_PENDING, replaced: existing !== undefined };
}

/**
 * 给一条表情包目录条目**改名**（按旧名字匹配，两个区都找）。
 *
 * 为什么需要它（真实事故）：模型想给一张已收藏的表情换个名字，只能「用新名字再
 * `qq_save_sticker` 存一遍」—— 于是目录里多出一张同画面、不同名的图，旧名那条还留着，
 * 两张以后都会被挑中。改名是「同一个文件换个名字」，不是「再存一张」。
 *
 * 与 `upsertStickerRow` 的区别：那个按**新名字**找同一条，找不到就追加；这里按**旧名字**
 * 找人，把它的字段（画面 / 含义 / 场景 / 日期 / 置信）整行搬到新名字下 —— 没显式给新值的
 * 字段一律沿用旧的，免得改个名字就把含义丢了。旧名字那条不会留下。
 *
 * @param markdown - 现有内容。
 * @param from - 旧名字（收藏区 / 未收藏区都找）。
 * @param entry - `{ name, look?, meaning?, scene?, path, date?, confidence? }`，`name` 是新名字。
 * @returns `{ text, section, renamed }`：`renamed` = 旧条目在不在（不在就只追加一条新的）。
 */
export function renameStickerRow(markdown, from, entry) {
  const fromKey = compareKey(from);
  const nameKey = compareKey(entry?.name);
  if (fromKey.length === 0) throw new Error('rename needs the current sticker name');
  if (nameKey.length === 0) throw new Error('rename needs the new sticker name');
  const parsed = parseStickerCatalog(markdown);
  const existing = [...parsed.collected, ...parsed.pending].find((row) => compareKey(row.name) === fromKey);
  const pick = (value, fallback) => (String(value ?? '').trim().length > 0 ? value : fallback);
  const merged = {
    name: entry.name,
    look: pick(entry.look, existing?.look),
    meaning: pick(entry.meaning, existing?.meaning),
    scene: pick(entry.scene, existing?.scene),
    path: pick(entry.path, existing?.path),
    date: pick(entry.date, existing?.date),
    confidence: pick(entry.confidence, existing?.confidence),
  };
  // 有没有含义决定进哪个区：未收藏 → 改名时顺手补了含义就该升进已收藏（与 upsert 同一口径）。
  const hasMeaning = String(merged.meaning ?? '').trim().length > 0;
  const target = hasMeaning ? STICKER_COLLECTED : STICKER_PENDING;
  const wasCollected = parsed.collected.includes(existing);
  // 同一个区里改名就**原地换掉那一行**：改名不该把条目挪到目录末尾，否则前后顺序
  // （模型先学的 / 后学的）会随一次改名整体错位，人也不好看 diff。
  if (existing !== undefined && wasCollected === hasMeaning) {
    const lines = String(markdown ?? '').split(/\r?\n/);
    const at = lines.findIndex((line) => line.trim() === existing.line);
    if (at >= 0) {
      lines[at] = stickerRow(merged);
      return { text: lines.join('\n'), section: target, renamed: true };
    }
  }
  // 换区（未收藏 → 已收藏）只能先删再插：`appendStickerRow` 负责把行放进目标区的最后。
  let body = String(markdown ?? '');
  if (existing !== undefined) body = dropLines(body, (line) => line.trim() === existing.line);
  const { text, section } = appendStickerRow(body, merged, { collected: hasMeaning });
  return { text, section, renamed: existing !== undefined };
}

/**
 * 删掉一条表情包目录条目（按名字匹配，两个区都找）。
 * @returns `{ text, removed }`。
 */
export function removeStickerRow(markdown, name) {
  const key = compareKey(name);
  const parsed = parseStickerCatalog(markdown);
  const hit = [...parsed.collected, ...parsed.pending].find((row) => compareKey(row.name) === key);
  if (hit === undefined) return { text: String(markdown ?? ''), removed: false };
  return { text: dropLines(markdown, (line) => line.trim() === hit.line), removed: true };
}

/**
 * 归一化一份记忆文档：重复的二级标题只留第一个，同一个键的条目只留最后一条。
 *
 * 为什么在**写入时**做：这文件是模型用自由文本 append 出来的，重复标题、同名条目
 * 都是「写的时候顺手」造成的（真实事故：`## 黑话与缩写` 出现两次，中间夹着一个
 * 已经没有图的 `## 表情包`）。读路径不动它 —— 读要如实反映磁盘上的内容。
 *
 * 它**不重排**条目（顺序对人是可读性，对注入没有语义，见 `hotCognitionLines`），
 * 也**不删除**解析不了的行：那些是用户写下的字，只由 `qq_memory read` 标出来。
 * @param markdown - 文件内容。
 * @param keyOf - 一行 → 去重键（不是条目行时返回 undefined）。
 */
function normalizeDoc(markdown, keyOf) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const lastAt = new Map();
  for (const [index, line] of lines.entries()) {
    const key = keyOf(line);
    if (key !== undefined) lastAt.set(key, index);
  }
  const seenHeadings = new Set();
  const out = [];
  for (const [index, line] of lines.entries()) {
    const heading = sectionName(line);
    if (heading.length > 0) {
      if (seenHeadings.has(heading)) continue;
      seenHeadings.add(heading);
      out.push(line);
      continue;
    }
    const key = keyOf(line);
    if (key !== undefined && lastAt.get(key) !== index) continue;
    out.push(line);
  }
  // 标题下面紧跟空行是删重复标题时留下的痕迹：收掉，别让文件越整理越松。
  return `${out.join('\n').replace(/(^#{2,3}[^\n]*\n)\n+/gm, '$1').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** `COGNITION.md` 的写入归一化（见 {@link normalizeDoc}）。 */
export function normalizeCognitionDoc(markdown) {
  return normalizeDoc(markdown, (line) => {
    if (!/^[-*]\s/.test(line.trim())) return undefined;
    // 认知库只合并**完全相同的行**：同一个写法在不同群里意思不同时，本来就是两条
    // （skill 明确允许），按写法去重会把其中一条吃掉。
    const entry = parseCognition(`${line.trim()}\n`).entries[0];
    return entry === undefined ? undefined : compareKey(line);
  });
}

/**
 * 文件里出现不止一次的二级标题（体检用）。
 *
 * 这不是「分类」，是同一个标题被 append 了两遍 —— 条目会散在两处，人翻的时候以为
 * 自己看漏了（真实事故：`## 黑话与缩写` 出现两次，中间夹着一个空掉的 `## 表情包`）。
 * @param markdown - 文件内容。
 * @returns 重复的标题名数组（顺序按首次出现）。
 */
export function duplicateSectionNames(markdown) {
  const counts = new Map();
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const name = sectionName(line);
    if (name.length === 0) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

/** `STICKERS.md` 的写入归一化（见 {@link normalizeDoc}）。 */
export function normalizeStickerDoc(markdown) {
  return normalizeDoc(markdown, (line) => {
    if (!/^[-*]\s/.test(line.trim())) return undefined;
    const name = splitFields(line.trim().replace(/^[-*]\s+/, ''))[0];
    return compareKey(name);
  });
}
