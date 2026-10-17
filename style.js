/**
 * 表达层：「怎么说」—— 气泡计划、标点清洗、图片与引用的关系。
 *
 * 这一层刻意分成两半，分界线是**能不能机械判断**：
 *
 *   - **能机械执行的放这里**（引擎）：一条回复发几个气泡、句末那个「。」要不要剥、
 *     图要不要挂引用、信息型回复不掷骰。判据是「字符串 + 数字 → 布尔」，不改语义。
 *   - **只能模型判断的写进 `STYLE.md`**（散文）：逗号多不多、这句话该不该分两拍、
 *     是非题要不要追问、损人的分寸。这些交给提示词与 few-shot，**绝不做字符串替换**。
 *
 * 为什么「连续短句」是发送前一次计划，而不是每条发完再判（§3.2 的结论）：
 * 每条判一次意味着每条一次模型调用（成本 ×3、还会往会话里塞伪造消息），或者一次
 * 异步判定 —— 而发送队列是串行的，异步判定要么插进队列（乱序）要么另起一条队列
 * （交错），而且 OneBot 没有「对方正在输入」信号，追加判定拿不到任何新信息。
 * 计划时的骰子没有这个窗口期：用户观感等价，却确定、可测、零额外调用。
 *
 * @module @qqbot/dsh-plugin-qq/style
 */
import { createDocReader } from './docfile.js';

/** 追问钩子的概率加成：以问号结尾的气泡更难被掷掉（封顶 0.9）。 */
const HOOK_BOOST = 1.3;
const HOOK_CAP = 0.9;

/**
 * 内置的表达契约：`STYLE.md` 不存在时用它。
 *
 * 与 `PERSONA.md` 的分工写在这里而不是提示词里：人设只说「是谁」，这里只说「怎么说」。
 * 每一条都是能落地执行或能举例的，不写「自然一点」这种没法判断的话。
 */
const BUILTIN_PROSE = {
  general: [
    '一条回复 1~2 个气泡（最多 3 个），每个气泡一句话；要展开就分成 3~5 个短气泡，别写成一整段。',
    '每个气泡都要能独立成立；必须说的先放第一个气泡。',
    '不写序号、列表、Markdown、括号旁白。',
  ],
  punctuation: [
    '短句句末不加「。」；问号、感叹号、省略号、波浪号照常用。',
    '一句里逗号最多一个；顿号按需。',
    '不用「……」超过一次，不用「！！」叠用。',
  ],
  sticker: [
    '纯情绪（笑、无语、委屈、拒绝、赞成、撒娇、接梗）优先只发一张表情，别用文字描述情绪。',
    '有信息要说就说话，别拿表情代替答案。',
    '一次最多一张；表情后面不接「给你发张表情包」这种说明。',
  ],
  privateChat: [
    '答完可以带一个短追问（「你呢」「要不要我去看看」），别每句都追问。',
    '不用每句都叫对方名字。',
  ],
  group: [
    '别人没叫你时，插话只接最后一句，不总结、不科普、不拉长。',
    '接不住就不接。',
  ],
};

/** `STYLE.md` 里认得的五个节名 → 内部键。 */
const STYLE_SECTIONS = {
  总体: 'general',
  标点: 'punctuation',
  表情包: 'sticker',
  私聊: 'privateChat',
  群聊: 'group',
};

/**
 * 解析 `STYLE.md`：只有 `##` 分节与 `-` 列表，没有 DSL、没有 YAML。
 *
 * 为什么是这种「简单到能正则切」的格式：零依赖是硬约束（不能引 Markdown 库），而且
 * 写它的是部署者 —— 结构越少，写歪了也还能用。不认得的节名忽略并记一条 warn。
 *
 * @param {string} markdown - 文件内容。
 * @returns `{ prose, warnings }`：`prose` 的键是 general / punctuation / sticker /
 *   privateChat / group（缺失的节为空数组，渲染时跳过）。
 */
export function parseStyleDoc(markdown) {
  const prose = { general: [], punctuation: [], sticker: [], privateChat: [], group: [] };
  const warnings = [];
  let current;
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // `###` 及更深的小节只是排版（我们不分层），`#` 一级标题是文件标题：都跳过，
    // 且**不**重置当前节 —— 否则一个 `### 例子` 会把整节后面都吞掉。
    if (/^#{3,}/.test(line)) continue;
    if (/^#[^#]/.test(line)) continue;
    const heading = /^##\s*(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const key = STYLE_SECTIONS[heading[1]];
      if (key === undefined) {
        warnings.push(`STYLE.md 里不认识的节「${heading[1]}」，已忽略`);
        current = undefined;
      } else {
        current = key;
      }
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item === null) {
      // 段落说明（没有 `-` 的行）也收进去：部署者常先写一句「总体要求」再列条。
      if (current !== undefined) prose[current].push(line);
      continue;
    }
    if (current !== undefined) prose[current].push(item[1].trim());
  }
  return { prose, warnings };
}

/** 内置契约的副本（每次给新对象，调用方随便改不会污染模块级常量）。 */
export function builtinStyle() {
  return {
    general: [...BUILTIN_PROSE.general],
    punctuation: [...BUILTIN_PROSE.punctuation],
    sticker: [...BUILTIN_PROSE.sticker],
    privateChat: [...BUILTIN_PROSE.privateChat],
    group: [...BUILTIN_PROSE.group],
  };
}

/**
 * 把「散文 + 机器参数」渲染成提示词里的表达契约。
 *
 * 散文与参数**互相不解析**：参数不是从 `STYLE.md` 里读出来的，`STYLE.md` 也不能
 * 覆盖参数 —— 两边各管一半，免得又长出一套「写歪了就静默失效」的 DSL。
 *
 * @param {object} options
 * @param {object} options.prose - {@link parseStyleDoc} 的 `prose`（或一个节）。
 * @param {object} options.params - 机器参数（见 index.js 里那次装配）。
 * @param {'private'|'group'} options.scene - 用哪一段场景散文。
 * @param {boolean} options.imageAllowed - 能不能发图（不能时不提表情包那一条）。
 * @returns {string[]} 提示词行；调用方负责拼进槽位。
 */
export function renderStyleContract({ prose, params, scene, imageAllowed = false }) {
  const lines = [];
  const general = prose?.general ?? [];
  if (general.length > 0) lines.push(...general.map((line) => `- ${line}`));
  // 机器参数：每条都是「模型照做得到、引擎也真的执行」的硬规则。
  if (Number(params?.bubbleChatMax) > 0) {
    lines.push(`- 一条回复最多 ${params.bubbleChatMax} 个气泡（超出的并进最后一个）；聊天型回复发几个由插件决定，你只管把想说的按气泡写开。`);
  }
  if (params?.stripShortPeriod === true) {
    lines.push(`- 短句（不超过 ${params.shortPeriodMaxChars} 字）句末不要写「。」—— 插件也会替你剥掉；问号、感叹号、省略号照常用。`);
  }
  if (params?.humanize === false) {
    lines.push('- 你的整轮回复会作为一条消息直接发出去（换行也留在同一条里），直接写要说的话。');
  }
  const punctuation = prose?.punctuation ?? [];
  if (punctuation.length > 0) lines.push(...punctuation.map((line) => `- ${line}`));
  if (imageAllowed && (prose?.sticker ?? []).length > 0) {
    lines.push(...prose.sticker.map((line) => `- ${line}`));
  }
  const sceneLines = scene === 'private' ? (prose?.privateChat ?? []) : (prose?.group ?? []);
  if (sceneLines.length > 0) lines.push(...sceneLines.map((line) => `- ${line}`));
  if (params?.interjectQuote === true) {
    lines.push('- 群里插话那一轮，插件会引用你要接的那句话；你只管接住它，不用自己点名。');
  }
  return lines;
}

/**
 * 这一轮回复算「聊天型」还是「信息型」。
 *
 * 判据是**内容**而不是长度：要贴代码 / 列步骤 / 解释一件事的回复不该被骰子吞掉，
 * 而闲聊再长也还是闲聊。这里能给引擎的只有长度这个代理指标，所以门槛可配
 * （`burstSingleMaxChars` 优先，否则 `bubbleGambleMaxChars`）。
 *
 * @param {string} text - 整轮回复正文（含标记也照算，长一点更安全）。
 * @param {object} options - `chatMaxChars`：超过它就算信息型；`<= 0` = 全部按聊天型。
 * @returns {'chat'|'informational'}
 */
export function classifyReply(text, { chatMaxChars = 80 } = {}) {
  const max = Number(chatMaxChars) || 0;
  if (max <= 0) return 'chat';
  const length = String(text ?? '').replace(/\s+/g, '').length;
  return length > max ? 'informational' : 'chat';
}

/**
 * 气泡计划（§6.4 的核心算法）：**发送前一次**决定这一轮发到第几个气泡。
 *
 * 不变量（都写进了 test/style.test.mjs）：
 *   1. 第一个气泡永远发 —— 绝不出现「话说一半、连开头都没有」；
 *   2. 前缀性质：不会出现「发了第 1、3 条，跳过第 2 条」；
 *   3. 含图段不掷：只要这一轮有图，全部按原顺序发送（图不会被骰子吞掉，
 *      图前后的文字也不会被拆开 —— 顺序语义优先）；
 *   4. 信息型不掷：总长超过门槛、`gamble` 关着、`humanize` 关着时原样发；
 *   5. 概率递减：第 2 个 `chance`、第 3 个 `chance × decay`、第 4 个再乘一次；
 *   6. 追问钩子加保：第 i 个气泡以问号结尾时概率 ×1.3（封顶 0.9）——
 *      那是把对话接下去的关键，别让它总被掷掉；
 *   7. 可复现：`rng` 由调用方注入，测试传固定序列。
 *
 * @param {object[]} pieces - 已拆好的分段（`{ kind: 'text'|'image', text? }`）。
 * @param {object} options
 * @param {boolean} options.gamble - 总开关（`bubbleGamble`）。
 * @param {number} options.chance - 第二个气泡的保留概率。
 * @param {number} options.decay - 每多一个乘一次。
 * @param {'chat'|'informational'} options.mode - {@link classifyReply} 的结果。
 * @param {() => number} [options.rng] - 随机源（默认 `Math.random`）。
 * @returns {object[]} 要真正发出去的前缀子集。
 */
export function planBubbles(pieces, { gamble = true, chance = 0.55, decay = 0.5, mode = 'chat', rng = Math.random } = {}) {
  const list = Array.isArray(pieces) ? pieces : [];
  if (list.length <= 1) return list;
  if (gamble !== true || mode !== 'chat') return list;
  if (list.some((piece) => piece?.kind === 'image')) return list;
  const base = Math.min(1, Math.max(0, Number(chance)));
  const decayRate = Math.min(1, Math.max(0, Number(decay)));
  let keep = 1;
  for (let index = 1; index < list.length; index += 1) {
    // 递减：第 2 个用 base，第 3 个 base×decay，以此类推。
    let probability = base * decayRate ** (index - 1);
    if (/[？?]\s*$/.test(String(list[index]?.text ?? ''))) {
      probability = Math.min(HOOK_CAP, probability * HOOK_BOOST);
    }
    if (!(rng() < probability)) break;
    keep = index + 1;
  }
  return list.slice(0, keep);
}

/**
 * 清洗一个气泡：只做「改了也不会改变意思」的那几件事。
 *
 * **能改**：首尾空白；短气泡句末唯一的「。」；三个以上连续「。」 → 一个「…」；
 * 连续空格 → 一个空格。
 * **绝不改**：气泡中间的标点、逗号数量、断句、长气泡的句号、全角半角、颜文字。
 * 删逗号会改变语义（「我说，你听」→「我说你听」），所以逗号只能靠 `STYLE.md` 的契约
 * 约束，不能字符串替换 —— 这是本模块最重要的一条边界。
 *
 * @param {string} text - 一个气泡的正文。
 * @param {object} options - `stripShortPeriod`、`shortPeriodMaxChars`。
 * @returns {string|undefined} 清洗后的正文；整条只剩标点（剥完为空）时 undefined。
 */
export function sanitizeBubble(text, { stripShortPeriod = true, shortPeriodMaxChars = 40 } = {}) {
  let body = String(text ?? '').trim();
  if (body.length === 0) return undefined;
  // 连续「。」先并成一个省略号：这在长气泡里也只是排版，不改语义。
  body = body.replace(/。{3,}/g, '…').replace(/[ \t]{2,}/g, ' ').trim();
  const limit = Math.max(1, Math.floor(Number(shortPeriodMaxChars) || 40));
  // 「短」按去掉空白后的字数算：换行/缩进不该把一条短句顶到长气泡那一侧。
  const short = body.replace(/\s+/g, '').length <= limit;
  if (stripShortPeriod && short && body.endsWith('。') && !body.endsWith('。。')) {
    body = body.slice(0, -1).trimEnd();
    if (body.length === 0) return undefined;
  }
  return body;
}

/**
 * 造一个表达规则读取器：热读 `STYLE.md`、解析、写坏时回退到上一版。
 *
 * 与 `persona.js` 的读者同一套语义（由 `docfile.js` 共用）：同步读（提示词 provider 是
 * 同步求值的）、按 `size:mtime` 缓存、超出 `styleMaxChars` 截断并 warn、文件必须在 cwd 内。
 * 文件不存在时返回 undefined —— 调用方据此退回内置契约。
 *
 * @param {object} options - `{ cwd, file, maxChars, report }`。
 * @returns `{ read(): { prose, warnings } | undefined, path }`。
 */
export function createStyle({ cwd, file, maxChars = 2000, report }) {
  const reader = createDocReader({ cwd, file, maxChars, report, label: '表达规则' });
  let lastGood;
  return {
    path: reader.path,
    read() {
      const { text } = reader.read();
      if (text === undefined) return undefined;
      const parsed = parseStyleDoc(text);
      for (const warning of parsed.warnings) report('warn', warning);
      const empty = Object.values(parsed.prose).every((lines) => lines.length === 0);
      if (empty) {
        report('warn', `表达规则文件 ${reader.path} 里没有可用的内容，继续用上一版/内置契约`);
        return lastGood === undefined ? undefined : { prose: lastGood, warnings: [] };
      }
      lastGood = parsed.prose;
      return parsed;
    },
  };
}
