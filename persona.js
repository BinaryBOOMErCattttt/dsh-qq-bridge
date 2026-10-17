/**
 * 人格层：`PERSONA.md` 的解析与提示词渲染。
 *
 * 一句话分工：**人设只写「是谁」，表达规则写进 `STYLE.md`**。这条线是从一次真实问题
 * 上切出来的 —— 部署的 persona 里混着「从不拿句号收尾」「优先用表情表达情绪」，
 * 那些是表达规则，写进人设的结果是「改一次口吻要动人设、还没有任何机械校验」。
 *
 * 为什么性格要分「底色 / 点缀」而不是五条平铺（§3.1）：
 *
 *   - 纯追加没有优先级，模型会把它们**平均**成一个温吞、没有棱角、谁也不像的人；
 *   - 性格之间会冲突（温柔 + 毒舌 = 阴阳怪气，傲娇 + 直球 = 精神分裂），必须规定
 *     「什么时候允许哪一条上场」。
 *
 * 所以：**底色最多一条**（始终在场，是语气的地板），**点缀按触发条件上场、一次最多一个**。
 * 隐喻「地板不是台词」写进渲染出来的提示词，不然模型会把每一条都演一遍。
 *
 * 文件格式刻意是「极简 Markdown 子集」：`##` 分节、`-` 列表、`[x]` 勾选。零依赖，
 * 写歪了最多降级一条，不会整份读不出来。
 *
 * 解析**绝不抛错**：返回 `{ profile, warnings }`，坏条目跳过并记进 `warnings` ——
 * 人设文件写坏绝不能让机器人不说话。
 *
 * @module @qqbot/dsh-plugin-qq/persona
 */
import { createDocReader } from './docfile.js';

/** 认得的四个二级节名（其余忽略并 warn）。 */
const SECTIONS = ['身份', '背景', '性格', '场景'];

/** 场景小节名 → 内部键。 */
const SCENES = {
  私聊: 'private',
  群聊: 'group',
  主动搭话: 'proactive',
  被戳一戳: 'poke',
};

/** 「底色」的几种写法：只要语义是「始终在场」，都认。 */
const BASE_WORDS = new Set(['底色', '基础', '基本', '主色调', '底色性格']);

/**
 * 解析勾选框：`[x]` 启用、`[ ]` 停用；**没有勾选框的条目视为启用**（兼容手写习惯）。
 * @param line - 去掉 `- ` 之后的一行。
 * @returns `{ enabled, rest }`。
 */
function readCheckbox(line) {
  const match = /^\[([ xX✓])\]\s*(.*)$/.exec(line);
  if (match === null) return { enabled: true, rest: line };
  return { enabled: match[1].trim().length > 0, rest: match[2] };
}

/**
 * 解析 `## 身份` 下的 `- 名字：小栞` 键值行。
 * @param line - 去掉 `- ` 之后的一行。
 * @returns `{ key, value }`；没有冒号时 key 为空、整行进 value。
 */
function readPair(line) {
  const at = line.search(/[：:]/);
  if (at < 0) return { key: '', value: line.trim() };
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
}

/**
 * 解析一条性格：`名字｜底色/点缀｜强度｜触发条件｜表现｜禁忌（可选）`。
 *
 * 段数不足时**降级而不是报错**：只有名字 + 描述时，把它当点缀、强度 0.5 —— 写歪一条
 * 不该让整份人设失效（这一条在 §5.1 里明确要求）。
 * @param line - 去掉 `- [x] ` 之后的一行。
 * @returns 性格条目。
 */
function readTrait(line) {
  const fields = String(line ?? '')
    .split(/[｜|]/)
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  const name = fields[0] ?? '';
  if (fields.length < 2) {
    return { name, role: 'accent', strength: 0.5, trigger: '', expression: '', taboo: '' };
  }
  const roleWord = fields[1] ?? '';
  const role = BASE_WORDS.has(roleWord) ? 'base' : 'accent';
  const strengthRaw = Number.parseFloat(fields[2] ?? '');
  const strength = Number.isFinite(strengthRaw) ? Math.min(1, Math.max(0, strengthRaw)) : 0.5;
  // 五段是标准形状；只有「名字｜描述」两段时，第二段本来是角色词，这里降级成表现。
  const standard = fields.length >= 4;
  return {
    name,
    role,
    strength,
    trigger: standard ? (fields[3] ?? '') : '',
    expression: standard ? (fields[4] ?? '') : (fields.slice(1).join('｜')),
    taboo: standard ? (fields[5] ?? '') : '',
  };
}

/**
 * 解析 `PERSONA.md`。
 *
 * @param {string} markdown - 文件内容（不存在时传空串）。
 * @returns {{ profile: object, warnings: string[] }}：
 *   `profile = { identity: [{key,value}], background: string[], traits: object[],
 *   scenes: { private: string[], group: string[], proactive: string[], poke: string[] } }`。
 */
export function parsePersonaDoc(markdown) {
  const profile = { identity: [], background: [], traits: [], scenes: { private: [], group: [], proactive: [], poke: [] } };
  const warnings = [];
  let section = '';
  let scene = '';
  for (const [index, raw] of String(markdown ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0 || /^<!--/.test(line)) continue;
    // `###` 只在「场景」里有意义；其余位置的子标题忽略。
    const sub = /^###\s*(.+?)\s*$/.exec(line);
    if (sub !== null) {
      const key = SCENES[sub[1]];
      if (key === undefined) {
        warnings.push(`PERSONA.md 第 ${index + 1} 行：不认识的场景「${sub[1]}」，已忽略`);
        scene = '';
      } else {
        scene = key;
      }
      continue;
    }
    const heading = /^##\s*(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = heading[1];
      if (!SECTIONS.includes(name)) {
        warnings.push(`PERSONA.md 第 ${index + 1} 行：不认识的节「${name}」，已忽略（只认身份 / 背景 / 性格 / 场景）`);
        section = '';
        scene = '';
        continue;
      }
      section = name;
      scene = '';
      continue;
    }
    if (line.startsWith('#')) continue; // 一级标题只是文件标题。
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item === null) {
      // 段落说明（没写 `-` 的行）：按当前节收进去，写手少写一个横线不该丢掉一句话。
      if (section === '身份') profile.identity.push(readPair(line));
      else if (section === '背景') profile.background.push(line);
      else if (section === '性格') warnings.push(`PERSONA.md 第 ${index + 1} 行：性格要用「- 名字｜底色/点缀｜…」的列表写法，已忽略`);
      else if (section === '场景' && scene.length > 0) profile.scenes[scene].push(line);
      continue;
    }
    if (section === '身份') {
      profile.identity.push(readPair(item[1]));
      continue;
    }
    if (section === '背景') {
      profile.background.push(item[1].trim());
      continue;
    }
    if (section === '性格') {
      const { enabled, rest } = readCheckbox(item[1]);
      const trait = readTrait(rest);
      if (trait.name.length === 0) {
        warnings.push(`PERSONA.md 第 ${index + 1} 行：性格条目没有名字，已忽略`);
        continue;
      }
      profile.traits.push({ ...trait, enabled });
      continue;
    }
    if (section === '场景' && scene.length > 0) profile.scenes[scene].push(item[1].trim());
  }
  // 底色最多一条：多条时保留第一条启用的，其余降级成点缀并明说 —— 两条底色同时在场，
  // 模型会把它们揉成一个谁都不像的性格，而这恰恰是分层要避免的。
  let baseSeen = false;
  for (const trait of profile.traits) {
    if (!trait.enabled || trait.role !== 'base') continue;
    if (!baseSeen) {
      baseSeen = true;
      continue;
    }
    trait.role = 'accent';
    warnings.push(`PERSONA.md 里有多条底色：「${trait.name}」已按点缀处理（底色最多一条）`);
  }
  return { profile, warnings };
}

/**
 * 把解析结果渲染成提示词里的「人设」段。
 *
 * 顺序照 §5.2：身份 → 背景 → 底色 → 此刻可能上场的点缀 → 场景 → 冲突规则。
 * 渲染里每一句都在告诉模型「这是倾向、不是台词」，因为不这么说，模型就会把
 * 五条性格当成五条待办、逐条表演一遍。
 *
 * @param {object} profile - {@link parsePersonaDoc} 的 `profile`。
 * @param {object} [options]
 * @param {'private'|'group'|'proactive'|'poke'} [options.scene] - 当前场景。
 * @param {boolean} [options.overlays] - 是否叠加场景段（`personaSceneOverlays`）。
 * @returns {string[]} 提示词行；**整份人设为空时返回空数组**（调用方据此回退到内置人设）。
 */
export function renderPersona(profile, { scene = 'group', overlays = true } = {}) {
  if (profile === undefined) return [];
  const identity = (profile.identity ?? []).filter((pair) => pair.value.length > 0);
  const background = (profile.background ?? []).filter((line) => line.length > 0);
  const traits = (profile.traits ?? []).filter((trait) => trait.enabled && trait.name.length > 0);
  const sceneLines = overlays ? (profile.scenes?.[scene] ?? []) : [];
  if (identity.length === 0 && background.length === 0 && traits.length === 0 && sceneLines.length === 0) return [];

  const lines = ['你的人设（这些是倾向，不是台词；别逐条表演）：'];
  if (identity.length > 0) {
    lines.push(`【身份】${identity.map((pair) => (pair.key.length > 0 ? `${pair.key}：${pair.value}` : pair.value)).join('；')}`);
  }
  if (background.length > 0) {
    lines.push(`【背景】${joinClauses(background)}`);
  } else {
    lines.push('【背景】这些是事实，不是每轮都要念的台词。');
  }
  const base = traits.find((trait) => trait.role === 'base');
  if (base !== undefined) {
    lines.push(`【底色｜始终在场】${describeTrait(base)}`);
  }
  const accents = traits.filter((trait) => trait.role !== 'base');
  if (accents.length > 0) {
    lines.push('【此刻可能上场｜一次最多演一个】');
    for (const accent of accents) lines.push(`  ${describeTrait(accent)}`);
  }
  if (sceneLines.length > 0) {
    const title = { private: '私聊', group: '群聊', proactive: '主动搭话', poke: '被戳一戳' }[scene] ?? '当前场景';
    lines.push(`【场景｜${title}】${joinClauses(sceneLines)}`);
  }
  lines.push('冲突时：底色优先；一项点缀在一句话里只演一次。性格不是结构 —— 不许用「先嘴硬一句、再补一段正经的」来演傲娇。');
  return lines;
}

/**
 * 把几条句子拼成一句：去掉句末的「。」再补「；」。
 *
 * 不这么做的结果是「。；」—— 人设文件里每条都写了句号，直接 join 读起来像拼贴。
 * 只剥末尾的一个句号，句中的标点原样留着。
 */
function joinClauses(list) {
  return list.map((line) => String(line).replace(/[。.]\s*$/, '')).join('；');
}

/** 一条性格渲染成一行：`触发条件 → 名字：表现（禁忌：…）`。 */
function describeTrait(trait) {
  const trigger = trait.trigger.length > 0 ? `${trait.trigger} → ` : '';
  const taboo = trait.taboo.length > 0 ? `（禁忌：${trait.taboo}）` : '';
  return `${trigger}${trait.name}：${trait.expression}${taboo}`;
}

/**
 * 造一个人设读取器：热读文件、解析、坏文件回退到上一次成功的结果。
 *
 * 为什么要有「上一次成功」：人设文件被编辑器写成半截（或者手滑删了一个字段）时，
 * 解析出来可能是空 profile。直接用它等于**机器人突然没人设了**；退回上一版至少
 * 还是同一个人。再往下的兜底（配置里的 `persona` / 内置人设）由 index.js 负责。
 *
 * @param {object} options - `{ cwd, file, maxChars, report }`。
 * @returns `{ read(scenePrompt): object|undefined, path }`：`read()` 返回解析好的 profile，
 *   文件不存在/没配时返回 undefined（调用方据此走兼容回退）。
 */
export function createPersona({ cwd, file, maxChars = 4000, report }) {
  const reader = createDocReader({ cwd, file, maxChars, report, label: '人设' });
  let lastGood;
  return {
    path: reader.path,
    /**
     * 读并解析（有缓存与回退）。
     * @returns `{ profile, warnings } | undefined`。
     */
    read() {
      const { text } = reader.read();
      if (text === undefined) return undefined;
      const parsed = parsePersonaDoc(text);
      for (const warning of parsed.warnings) report('warn', warning);
      const empty = parsed.profile.identity.length === 0
        && parsed.profile.background.length === 0
        && parsed.profile.traits.length === 0
        && Object.values(parsed.profile.scenes).every((lines) => lines.length === 0);
      if (empty) {
        report('warn', `人设文件 ${reader.path} 里没有可用的内容，继续用上一版/内置人设`);
        return lastGood === undefined ? undefined : { profile: lastGood };
      }
      lastGood = parsed.profile;
      return parsed;
    },
  };
}
