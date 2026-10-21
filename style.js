/**
 * 表达层：「怎么说」—— 标点清洗、聊天型 / 信息型判定、图片与引用的关系。
 *
 * 这一层刻意分成两半，分界线是**能不能机械判断**：
 *
 *   - **能机械执行的放这里**（引擎）：句末那个「。」要不要剥、这条回复算聊天型还是
 *     信息型、图要不要挂引用。判据是「字符串 + 数字 → 布尔」，不改语义。
 *   - **只能模型判断的写进 `STYLE.md`**（散文）：发几条、逗号多不多、这句话该不该分两拍、
 *     是非题要不要追问、损人的分寸。这些交给提示词与 few-shot，**绝不做字符串替换**。
 *
 * 发几条由模型自己写：插件**不改条数、不并条、不掷骰** —— 模型写几行就发几行。
 * 之前的「掷骰决定发到第几个」与「超出的并进最后一条」都已经删掉：那两套都会让
 * 模型写出来的话少一截，私聊里看起来就是它没回（真实事故）。
 *
 * @module @qqbot/dsh-plugin-qq/style
 */
import { createDocReader } from './docfile.js';

/**
 * 内置的表达契约：`STYLE.md` 不存在时用它。
 *
 * 与 `PERSONA.md` 的分工写在这里而不是提示词里：人设只说「是谁」，这里只说「怎么说」。
 * 每一条都是能落地执行或能举例的，不写「自然一点」这种没法判断的话。
 */
const BUILTIN_PROSE = {
  general: [
    '一条回复只用一个语气；发几条看你有几件事想说，一句能说完就一句，想接着说就换行多写一条；别每轮都排成同一个两段式。',
    '每个气泡都要能独立成立；必须说的先放第一个气泡。',
    '不写序号、列表、Markdown、括号旁白。',
  ],
  punctuation: [
    '短句句末不加「。」；问号、感叹号、省略号、波浪号照常用。',
    // 讲**频率**而不是「一句最多一个」：后者会被模型当成配额，正好凑成「几乎每句话
    // 都有一个逗号」（真实观感，见 lintStyleDoc 的 COMMA_QUOTA）。给替代做法才落地得到。
    '多数句子不带逗号：逗号只留给不带就会读错的地方，别每句都配一个。',
    '想说两件事就分成两条发（或者两个短句），别用逗号把两个能独立成句的分句缝成一句。',
    '反例：别写「我刚吃完饭，现在躺着呢，你呢」；写「刚吃完」「躺着」「你呢」。',
    // 逗号被压下去之后模型会找别的分隔符 —— 真实事故：群里所有回复变成
    // 「才没有 是你没跟上我」这种空格断句（中文里空格是断词，不是断句）。
    // 所以禁令要写成「不许拿空格顶替逗号」，并给出唯一合法的替代做法 —— **带改好的那句**：
    // 只给反例时模型知道「这样不对」，但会去猜「那该用什么」，又绕回空格。
    '两个分句要放在同一条里就用逗号分开；不许拿空格当标点 —— 中文的空格是断词不是断句（「才没有 是你没跟上我」要写成「才没有，是你没跟上我」，或者分成两条发）。',
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
 * 写它的是部署者 —— 结构越少，写歪了也还能用。
 *
 * **写歪的内容不丢**：不认得的节名、以及第一个 `##` 之前的段落，一律并进「总体」并记
 * 一条 warn。以前这里是「忽略」——结果是部署者写了十条规则、节名写错一个字，十条全部
 * 静默不进提示词，部署者只会觉得「改了没用」。宁可位置不对、内容也要生效。
 *
 * @param {string} markdown - 文件内容。
 * @returns `{ prose, warnings }`：`prose` 的键是 general / punctuation / sticker /
 *   privateChat / group（缺失的节为空数组，渲染时跳过）。
 */
export function parseStyleDoc(markdown) {
  const prose = { general: [], punctuation: [], sticker: [], privateChat: [], group: [] };
  const warnings = [];
  // 默认落在「总体」：第一个 `##` 之前的内容（以及不认识的节）都收在这里。
  let current = 'general';
  let sawHeading = false;
  let preambleWarned = false;
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // `###` 及更深的小节只是排版（我们不分层），`#` 一级标题是文件标题：都跳过，
    // 且**不**重置当前节 —— 否则一个 `### 例子` 会把整节后面都吞掉。
    if (/^#{3,}/.test(line)) continue;
    if (/^#[^#]/.test(line)) continue;
    const heading = /^##\s*(.+?)\s*$/.exec(line);
    if (heading !== null) {
      sawHeading = true;
      const key = STYLE_SECTIONS[heading[1]];
      if (key === undefined) {
        warnings.push(`STYLE.md 里不认识的节「${heading[1]}」，内容已并入「总体」`);
        current = 'general';
      } else {
        current = key;
      }
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    // 段落说明（没有 `-` 的行）也收进去：部署者常先写一句「总体要求」再列条。
    const text = item === null ? line : item[1].trim();
    if (!sawHeading && !preambleWarned) {
      warnings.push('STYLE.md 顶部（第一个 `##` 之前）的内容没有节名，已并入「总体」');
      preambleWarned = true;
    }
    prose[current].push(text);
  }
  return { prose, warnings };
}

/** 节名 → 日志里的中文叫法（lint 报错时用）。 */
const SECTION_LABELS = {
  general: '总体',
  punctuation: '标点',
  sticker: '表情包',
  privateChat: '私聊',
  group: '群聊',
};

/**
 * 用户最容易写出的十类「语法上没问题、语义上把人往客服腔推」的规则。
 *
 * 判据刻意收得窄：只抓**已知会诱发人机感**的措辞，不判断文笔好坏。宽词表会把
 * 「不要用序号、列表」这种正确的禁令也报出来，警告一多就没人看了。
 */
const STYLE_LINT_RULES = [
  {
    code: 'CUSTOMER_SERVICE',
    pattern: /(您好|感谢您的|感谢您对|有什么可以帮|希望(?:以上|这些)?对您有(?:所)?帮助|请问还需要|为您服务|请稍等)/,
    why: '客服腔是中文模型最熟的语气，写进契约会把回复拉回模板',
    fix: '删掉这类措辞；真要禁止就点名「不要写『您好』『感谢您的…』」，别反过来要求礼貌专业',
  },
  {
    code: 'VAGUE',
    pattern: /(自然一点|自然一些|生动|有个性|有温度|像真人|不要太机械|别太机械|有感情|有灵魂)/,
    why: '没有可执行判据，模型只能退回默认的助手腔',
    fix: '改成能验证的一条：句子多长、能不能用语气词、什么情况只回一句',
  },
  {
    code: 'FORBID_SPOKEN',
    pattern: /(?:不要|别|避免|禁止|勿)[^。；\n]{0,8}(?:语气词|网络用语|网络语言|口语|缩写|颜文字|波浪号|省略号)/,
    why: '整类禁掉会直接掐掉 QQ 语感',
    fix: '只禁具体的坏习惯（比如「一句话里别叠两个语气词」），别整类禁',
  },
  {
    code: 'STRUCTURE',
    pattern: /(分点|列点|列成几点|条理|总结一下|要总结|概括|完整的答复|完整答复|先说[^。；\n]{0,6}再)/,
    why: '和「不写列表 / 一次别发太多条」的硬规则对打，模型会平均成一段书面语',
    fix: '改成「先给结论、要展开就接着说」，别要求分点或总结',
  },
  {
    code: 'OVERRIDE',
    pattern: /(忽略以上|忽略上面|以此为准|优先级最高|覆盖以上|覆盖之前|不受以上限制)/,
    why: '表达契约压不过硬性规则，写这句只会让模型在两边平均',
    fix: '删掉覆盖声明；要改行为就改具体那一条规则',
  },
  {
    code: 'SELF_AI',
    pattern: /(?:(?:你|我)是(?:一个)?|作为(?:一个)?)\s*(?:AI|人工智能|助手|机器人)/i,
    why: '自称 AI / 助手是最典型的人机感来源，硬性规则里也已经禁了',
    fix: '删掉；要写身份就写名字、自称、跟群的关系',
  },
  {
    // 真实观感投诉：「几乎每句话都有一个逗号」。根因是这类**许可式**措辞 ——
    // 「逗号、顿号也正常」「一句里逗号最多一个」——被模型当成配额，于是句句配一个。
    // 逗号又不能机械删（见 sanitizeBubble），所以只能在契约这一侧把许可改成频率。
    code: 'COMMA_QUOTA',
    pattern: /(?:逗号|顿号)[^。；\n]{0,10}(?:也正常|正常用|随便|随意|都行|都可以|没关系|没问题)|(?:一句|每句|每个气泡)[^。；\n]{0,8}(?:最多)?一个逗号|逗号[^。；\n]{0,6}最多一个/,
    why: '「逗号也正常 / 一句最多一个」会被当成配额，结果每句话都配一个逗号，读起来是书面语',
    fix: '改成讲频率与替代做法：「多数句子不带逗号；想说两件事就分成两条发」，再配一句反例 → 正例',
  },
  {
    // 真实观感投诉：「每次只回一句」，读起来像客服在答工单。一条消息天然就是「收到、答复」
    // 的结构；真人聊天有时一句、有时接一句再补一句。这类写法把「省」写成了默认，
    // 而且它藏在标点 / 条数这类看起来无害的规则里，不点名就总会有人再写一遍。
    code: 'ONE_LINE',
    pattern: /(?:一句话能说完就只发一条|每次只回一句|默认只发一条|大多数时候只发一条|多数时候只发一条)/,
    why: '把「只回一条」写成默认，回复会变成一句式答案 —— 短、礼貌、像在答工单，看不出是熟人聊天',
    fix: '改成「一句能说完就一句，想接着说就多写一条；别每轮都排成同一个两段式」—— 条数由内容决定，不写数字默认值',
  },
  {
    // 与 ONE_LINE 是一对：只回一句是模板，固定两三句也是模板。真实回归（本仓库部署）：
    // 把「只发一条」改成「默认 1~3 条」之后，模型把 1~3 读成配额 —— 同一天 11 条回复里
    // 10 条正好两条，第二条几乎全是「接一句 + 补一句」的收尾，比一句式更像客服。
    code: 'COUNT_QUOTA',
    pattern: /(?:默认|固定|一律|总是|每次(?:都)?)\s*(?:[一二两三四五1-5]\s*(?:[~～\-—到至]\s*[一二两三四五1-5])?\s*条)/,
    why: '条数写成默认值，模型会当成配额（1~3 条最后总是 2 条），每轮同一个节奏就是人机感',
    fix: '改成由内容决定：「一句能说完就一句，想接着说就多写一条」，再补一句「别每轮都排成同一个两段式」',
  },
  {
    // 与 COMMA_QUOTA 是一对：把逗号按下去之后，模型不会凭空断句，它会找**别的分隔符**。
    // 真实事故（本仓库部署）：标点契约收紧成「多数句子不带逗号」+ 硬规则禁掉「两拍」之后，
    // 群里所有回复变成「才没有 是你没跟上我」「她吃草 我吃饭 不是一路的」——空格断句。
    // 所以这一条抓的是「标点整类禁掉」这种写法，修正方向是把逗号**还回去**（只禁句末句号）。
    code: 'NO_PUNCTUATION',
    // 间隙用 tempered dot：`不带逗号` / `不许拿空格当标点` 这种正确写法不能被误伤 ——
    // 它们恰恰是这一条要推荐的替代做法。
    pattern: /(?:不要|不用|不加|不带|别用|别加|禁止|避免|去掉|省掉|删掉|删去|不许|不准)(?:(?!空格|逗号|顿号|分句)[^。；\n]){0,6}(?:标点|符号)|(?:标点|符号)[^。；\n]{0,6}(?:一律|全部|统统|全都)?(?:去掉|省掉|删掉|删去|不要|不用)/,
    why: '标点整类禁掉，模型会拿空格顶替分句 —— 真实事故：群里的回复全变成「才没有 是你没跟上我」这种空格断句',
    fix: '只禁具体的：句末别加「。」；逗号留着断开两个分句（别每句都配一个），再明说一句「不许拿空格当标点」',
  },
];

/**
 * 给解析出来的散文做一次「人机感体检」。
 *
 * 位置在**解析之后、渲染之前**：不改内容、不改文件、不阻断 —— 只把「这句会把人往
 * 客服腔推」的地方连原因和改法一起报出来。写坏了最多是日志里多一条 warn，机器人
 * 照常说话（这条底线与 docfile.js 的失败语义一致）。
 *
 * @param {object} prose - {@link parseStyleDoc} 的 `prose`。
 * @returns {{section: string, sectionLabel: string, line: string, code: string,
 *   why: string, fix: string}[]} 命中的条目，按节与行序排列。
 */
export function lintStyleDoc(prose) {
  const hits = [];
  for (const [section, lines] of Object.entries(prose ?? {})) {
    for (const raw of lines ?? []) {
      const text = String(raw ?? '').trim();
      if (text.length === 0) continue;
      // 「不要写『您好』」是在禁止客服腔，不是在用客服腔：开头的否定词先挡掉两条
      // 正向词表（FORBID_SPOKEN 恰恰相反，它就是靠「不要…」触发的）。
      const negated = /^(?:不要|别|禁止|避免|不得|绝不能|不准)/.test(text);
      for (const rule of STYLE_LINT_RULES) {
        // 「不要写『默认 1~3 条』」是在禁止配额，不是在写配额：这三类正向词表先让开。
        if (negated && (rule.code === 'CUSTOMER_SERVICE' || rule.code === 'SELF_AI' || rule.code === 'COUNT_QUOTA')) continue;
        if (!rule.pattern.test(text)) continue;
        hits.push({
          section,
          sectionLabel: SECTION_LABELS[section] ?? section,
          line: text,
          code: rule.code,
          why: rule.why,
          fix: rule.fix,
        });
      }
    }
  }
  return hits;
}

/**
 * 数「多少条规则在告诉模型**别做什么**」用的词表。
 *
 * 只认**指令性**的否定词，并且刻意排掉三个高频假阳性：
 *
 *   - 「别人」（`别(?!人)`）—— 群聊规则里到处都是「别人说的…」，不是禁令；
 *   - 「特别」（`(?<!特)`）；
 *   - 「要不要」（`(?<![要])不要`）—— 「要不要我去看看」是提议，不是禁止。
 *
 * 也不含「不是」「不带」「没有」：那三个在正确的写法里出现在定义与频率句里
 * （「你在接话，不是写答复」「多数句子不带逗号」），算成禁令会让占比虚高。
 */
const BAN_WORDS = /(?<!特)别(?!人)|(?<![要])不要|不用|不许|不准|禁止|避免|勿|不写|不加|不拿|不列|不套|不接/;

/**
 * 表达规则的**结构**：不判断文笔，只数三个数。
 *
 * 来由是一个可重复的现象：把 `STYLE.md` 一条条改下去，人机感反而更难去掉。数出来才看清
 * —— 里面九成条目在说「别做什么」，告诉模型「那该做什么」的只有个位数。否定是减法：
 * 删掉坏选项之后模型只能退回训练分布里最安全的语域，而那个语域就是助手腔。所以
 * 「要写多少条正向」不是一个文风偏好，是两个能测的量：
 *
 *   - `ratio`：含禁令词的行 / 总行数。经验阈值 1/3；超过一半基本就是在一路做减法。
 *   - `bullets`：条目数。每条都在稀释其它条，12~16 条之后边际收益接近零。
 *
 * **它只报数，不判对错**：一条「别写括号旁白」是具体坏习惯，写得很对；占比才是问题所在。
 * `persona-check` 拿这三个数做提示，`lintStyleDoc` 仍然只管措辞。
 *
 * @param {object} prose - {@link parseStyleDoc} 的 `prose`。
 * @returns {{bullets: number, negative: number, ratio: number,
 *   sections: Record<string, {bullets: number, negative: number}>}} 。
 */
export function styleStructure(prose) {
  const sections = {};
  let bullets = 0;
  let negative = 0;
  for (const [section, lines] of Object.entries(prose ?? {})) {
    const list = (lines ?? []).map((line) => String(line ?? '').trim()).filter((line) => line.length > 0);
    const banned = list.filter((line) => BAN_WORDS.test(line)).length;
    sections[section] = { bullets: list.length, negative: banned };
    bullets += list.length;
    negative += banned;
  }
  return { bullets, negative, ratio: bullets > 0 ? negative / bullets : 0, sections };
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
  // 「发几条」不在这里、也不在配置里：模型自己写，插件不加条数上限、不改写换行。
  if (params?.stripShortPeriod === true) {
    lines.push(`- 短句（不超过 ${params.shortPeriodMaxChars} 字）句末不要写「。」—— 插件也会替你剥掉；问号、感叹号、省略号照常用。`);
  }
  if (params?.humanize === false) {
    lines.push('- 你的整轮回复会作为一条消息直接发出去（换行也留在同一条里），直接写要说的话。');
  } else {
    // 默认 `humanize: true`：换行就是分条，一行一条独立消息。不给这条，模型会把
    // 「回两条」写成同一行里的两句话 —— QQ 里看到的还是一个气泡（真实观感：像客服）。
    const maxMessages = Number(params?.maxMessages);
    lines.push(
      Number.isSafeInteger(maxMessages) && maxMessages > 0
        ? `- 想分几条发就换行：一行就是一条独立消息；一轮最多发 ${maxMessages} 条，多出来的会并进最后一条。`
        : '- 想分几条发就换行：一行就是一条独立消息（换行 = 分条，不是排版）；不想分条就别换行。',
    );
  }
  const punctuation = prose?.punctuation ?? [];
  if (punctuation.length > 0) lines.push(...punctuation.map((line) => `- ${line}`));
  if (imageAllowed && (prose?.sticker ?? []).length > 0) {
    lines.push(...prose.sticker.map((line) => `- ${line}`));
  }
  const sceneLines = scene === 'private' ? (prose?.privateChat ?? []) : (prose?.group ?? []);
  if (sceneLines.length > 0) lines.push(...sceneLines.map((line) => `- ${line}`));
  return lines;
}

/**
 * 这一轮回复算「聊天型」还是「信息型」。
 *
 * 现在只用来决定「发送途中对方又说话了，要不要停下来」：聊天型剩下的气泡不再发，
 * 信息型（贴代码 / 列步骤 / 解释一件事）整条讲完。条数本身不设上限 —— 模型写几条发几条。
 * 门槛可配（`burstSingleMaxChars`，0 = 全部按聊天型）。
 *
 * @param {string} text - 整轮回复正文（含标记也照算，长一点更安全）。
 * @param {object} options - `chatMaxChars`：超过它就算信息型；`<= 0` = 全部按聊天型。
 * @returns {'chat'|'informational'}
 */
export function classifyReply(text, { chatMaxChars = 100 } = {}) {
  const max = Number(chatMaxChars) || 0;
  if (max <= 0) return 'chat';
  const length = String(text ?? '').replace(/\s+/g, '').length;
  return length > max ? 'informational' : 'chat';
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
 * 解析警告与 {@link lintStyleDoc} 的体检**只在文件内容变化时跑一次**：写坏了不会阻断，
 * 但下一次热读一定会把它说清楚（见 `read()` 里的 `lastLinted`）。
 *
 * @param {object} options - `{ cwd, file, maxChars, report }`。
 * @returns `{ read(): { prose, warnings } | undefined, path }`。
 */
export function createStyle({ cwd, file, maxChars = 2000, report }) {
  const reader = createDocReader({ cwd, file, maxChars, report, label: '表达规则' });
  let lastGood;
  // 上一次做过体检的原文。提示词每轮装配都会调 `read()`，而解析与 warn 只跟内容有关：
  // 不在版本变化时收口，日志会被同一批警告刷满，真正的「这次改出了新问题」反而看不见。
  // 字符串比较是**按值**的，所以只是 touch 一下（内容没变）不会重报。
  let lastLinted;
  return {
    path: reader.path,
    read() {
      const { text } = reader.read();
      if (text === undefined) return undefined;
      const parsed = parseStyleDoc(text);
      const empty = Object.values(parsed.prose).every((lines) => lines.length === 0);
      if (text !== lastLinted) {
        lastLinted = text;
        for (const warning of parsed.warnings) report('warn', warning);
        const hits = lintStyleDoc(parsed.prose);
        for (const hit of hits) {
          report(
            'warn',
            `表达规则 ${reader.path} 的「${hit.sectionLabel}」有一条可能让人机感变强：「${hit.line}」`
              + ` —— ${hit.why}；${hit.fix}`,
          );
        }
        if (hits.length > 0) {
          report('warn', `表达规则体检：${hits.length} 处写法可能让人机感变强（逐条见上）；改文件不用重启，写歪了也只是 warn`);
        }
        if (empty) {
          report('warn', `表达规则文件 ${reader.path} 里没有可用的内容，继续用上一版/内置契约`);
        }
      }
      if (empty) return lastGood === undefined ? undefined : { prose: lastGood, warnings: [] };
      lastGood = parsed.prose;
      return parsed;
    },
  };
}
