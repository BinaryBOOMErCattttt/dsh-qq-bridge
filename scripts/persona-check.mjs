#!/usr/bin/env node
/**
 * 人设自检：**不启动机器人**，直接把 `PERSONA.md` / `STYLE.md` 解析一遍，把「模型会看到什么」
 * 和「哪里会让人机感变强」摆到台面上。
 *
 * 为什么需要这一层：人设写歪的失败方式全是**静默**的 —— 不认识的节记一条 warn 就跳过、
 * 性格段数不足降级成「名字 + 描述」、`STYLE.md` 里写一句「自然一点」只是不进提示词。
 * 部署者改完文件没有任何反馈渠道，只能靠「感觉机器人变了没有」。
 *
 * 所以这个脚本把几个纯函数的输出原样打出来（不读配置、不碰网络、不写文件）：
 *   - `persona.js` 的 `parsePersonaDoc` / `renderPersona`
 *   - `style.js` 的 `parseStyleDoc` / `lintStyleDoc` / `renderStyleContract`
 *
 * 用法（在仓库根目录）：
 *
 *     node scripts/persona-check.mjs
 *     node scripts/persona-check.mjs --persona .qq-persona/PERSONA.md --style .qq-persona/STYLE.md
 *     node scripts/persona-check.mjs --strict        # STYLE 体检命中也算「要改」
 *     node scripts/persona-check.mjs --json          # stdout 只有一个 JSON 对象
 *
 * 退出码：0 = 没有必须改的；1 = 有必须改的；2 = 用法或读文件出错。
 * `--json` 时给人看的文字全走 stderr（与 `scripts/ops.mjs` 同一条规矩：agent 解析 stdout）。
 *
 * @module @qqbot/dsh-plugin-qq/scripts/persona-check
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parsePersonaDoc, renderPersona } from '../persona.js';
import { lintStyleDoc, parseStyleDoc, renderStyleContract } from '../style.js';

/**
 * 两个文件的上限，抄的是 `config.js` 里 `personaMaxChars` / `styleMaxChars` 的默认值。
 * 刻意不 import `config.js`：那会把 `@deepseek-ai/schemastery` 拖进来，而自检脚本
 * 只需要解析函数 —— 它应该在「只有源码、没装依赖」的目录里也能跑。
 */
const PERSONA_MAX_CHARS = 4000;
const STYLE_MAX_CHARS = 2000;

/** 预览用的表达参数：按配置默认值来，文件里写的是「散文」，参数只影响预览。 */
const PREVIEW_PARAMS = { stripShortPeriod: true, shortPeriodMaxChars: 40, humanize: true };

const USAGE = `用法：node scripts/persona-check.mjs [--persona <path>] [--style <path>] [--strict] [--json]

  --persona <path>  人设文件，默认 .qq-persona/PERSONA.md（相对当前目录）
  --style <path>    表达规则文件，默认 .qq-persona/STYLE.md
  --strict          STYLE 的「人机感体检」命中也算必须改（退出码 1）
  --json            stdout 只输出一个 JSON 对象，给人看的文字走 stderr
  -h, --help        显示这段说明`;

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{persona: string, style: string, strict: boolean, json: boolean, help: boolean}}。
 * @throws {Error} 参数不认识或缺值（调用方转成退出码 2）。
 */
function parseArgs(argv) {
  const options = { persona: '.qq-persona/PERSONA.md', style: '.qq-persona/STYLE.md', strict: false, json: false, help: false };
  const takeValue = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 后面缺一个路径`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--persona') {
      options.persona = takeValue(index, '--persona');
      index += 1;
    } else if (arg.startsWith('--persona=')) options.persona = arg.slice('--persona='.length);
    else if (arg === '--style') {
      options.style = takeValue(index, '--style');
      index += 1;
    } else if (arg.startsWith('--style=')) options.style = arg.slice('--style='.length);
    else throw new Error(`不认识的参数「${arg}」`);
  }
  return options;
}

/**
 * 读一个文件；不存在时返回 `undefined` 而不是抛错（「还没写」是正常状态）。
 * 注意 `chars` 与 `bytes` 是两回事：`docfile.js` 的截断按**字符数**（`text.length`）算，
 * 中文一个字一个字，不是三个字节。按字节比会把一份 1000 字的 STYLE.md 误报成超限。
 *
 * @param {string} path - 相对当前目录或绝对路径。
 * @returns {{path: string, text: string|undefined, bytes: number, chars: number}}。
 */
function readText(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, text: undefined, bytes: 0, chars: 0 };
  const text = readFileSync(absolute, 'utf8');
  return { path: absolute, text, bytes: Buffer.byteLength(text, 'utf8'), chars: text.length };
}

/** 字节数说成人话。 */
function sizeLabel(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 一条 finding：`level` 是 error / warn / info，`where` 是 persona / style / cli。 */
function finding(level, where, message) {
  return { level, where, message };
}

/**
 * 解析并检查人设文件。
 * @param {{path: string, text: string|undefined, bytes: number}} file - `readText` 的结果。
 * @returns {{report: object|null, findings: object[]}}。
 */
function checkPersona(file) {
  if (file.text === undefined) return { report: null, findings: [] };
  const findings = [];
  const { profile, warnings } = parsePersonaDoc(file.text);
  for (const warning of warnings) findings.push(finding('error', 'persona', warning));

  const enabled = profile.traits.filter((trait) => trait.enabled && trait.name.length > 0);
  const base = enabled.filter((trait) => trait.role === 'base');
  const accent = enabled.filter((trait) => trait.role === 'accent');
  const keys = profile.identity.map((pair) => pair.key).filter((key) => key.length > 0);

  if (profile.identity.length === 0) findings.push(finding('error', 'persona', '「## 身份」是空的：模型不知道它是谁'));
  else if (!keys.includes('名字')) findings.push(finding('warn', 'persona', '「## 身份」里没有「名字」这一行 —— 模型会自己编一个称呼'));

  if (enabled.length === 0) findings.push(finding('error', 'persona', '一条启用的性格都没有：人设只剩身份和背景，说话没有棱角'));
  if (enabled.length > 0 && base.length === 0) findings.push(finding('warn', 'persona', '没有底色，只有点缀：点缀按触发上场，大部分时候就没有语气地板了'));
  if (accent.length > 2) findings.push(finding('warn', 'persona', `启用了 ${accent.length} 条点缀：三条以上会互相打架，模型会把它们平均成一个谁也不像的人`));

  const duplicateNames = enabled.map((trait) => trait.name).filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) findings.push(finding('warn', 'persona', `性格重名：${[...new Set(duplicateNames)].join('、')}`));

  const duplicateKeys = keys.filter((key, index, list) => list.indexOf(key) !== index);
  if (duplicateKeys.length > 0) findings.push(finding('warn', 'persona', `身份重名：${[...new Set(duplicateKeys)].join('、')}（渲染时后者会盖掉前者的观感）`));

  if (file.chars > PERSONA_MAX_CHARS) findings.push(finding('warn', 'persona', `文件 ${file.chars} 字，超过 personaMaxChars 默认值 ${PERSONA_MAX_CHARS}：超出的部分会被截断`));
  if (Object.values(profile.scenes).every((lines) => lines.length === 0)) findings.push(finding('info', 'persona', '四个场景段都是空的：私聊 / 群聊 / 主动搭话 / 被戳一戳共用同一套'));

  const preview = renderPersona(profile, { scene: 'group', overlays: true });
  const report = {
    path: file.path,
    exists: true,
    bytes: file.bytes,
    chars: file.chars,
    warnings,
    counts: {
      identity: profile.identity.length,
      background: profile.background.length,
      traits: profile.traits.length,
      enabled: enabled.length,
      base: base.length,
      accent: accent.length,
      scenes: Object.fromEntries(Object.entries(profile.scenes).map(([key, lines]) => [key, lines.length])),
    },
    traits: profile.traits.map((trait) => ({ name: trait.name, role: trait.role, strength: trait.strength, enabled: trait.enabled })),
    preview,
  };
  return { report, findings };
}

/**
 * 解析并检查表达规则文件（含人机感体检）。
 * @param {{path: string, text: string|undefined, bytes: number}} file - `readText` 的结果。
 * @param {boolean} strict - 体检命中是否算必须改。
 * @returns {{report: object|null, findings: object[]}}。
 */
function checkStyle(file, strict) {
  if (file.text === undefined) return { report: null, findings: [] };
  const findings = [];
  const { prose, warnings } = parseStyleDoc(file.text);
  for (const warning of warnings) findings.push(finding('error', 'style', warning));

  const counts = Object.fromEntries(Object.entries(prose).map(([key, lines]) => [key, lines.length]));
  const empty = Object.values(counts).every((count) => count === 0);
  if (empty) findings.push(finding('error', 'style', '文件里没有可用的规则：会退回上一版 / 内置表达契约'));

  const lint = lintStyleDoc(prose);
  for (const hit of lint) {
    findings.push(finding(strict ? 'error' : 'warn', 'style', `「${hit.sectionLabel}」这一条可能让人机感变强：「${hit.line}」—— ${hit.why}；${hit.fix}`));
  }

  const missing = Object.entries({ general: '总体', punctuation: '标点', sticker: '表情包', privateChat: '私聊', group: '群聊' })
    .filter(([key]) => (counts[key] ?? 0) === 0)
    .map(([, label]) => label);
  if (!empty && missing.length > 0) findings.push(finding('info', 'style', `没有这几节（会跳过，不报错）：${missing.join('、')}`));

  if (file.chars > STYLE_MAX_CHARS) findings.push(finding('warn', 'style', `文件 ${file.chars} 字，超过 styleMaxChars 默认值 ${STYLE_MAX_CHARS}：超出的部分会被截断`));

  const preview = renderStyleContract({ prose, params: PREVIEW_PARAMS, scene: 'group', imageAllowed: true });
  const report = {
    path: file.path,
    exists: true,
    bytes: file.bytes,
    chars: file.chars,
    warnings,
    counts,
    lint: lint.map((hit) => ({ section: hit.section, sectionLabel: hit.sectionLabel, line: hit.line, code: hit.code })),
    preview,
  };
  return { report, findings };
}

/**
 * 把结果打印成人话。
 * @param {Function} say - 输出一行（JSON 模式下已经换成 stderr）。
 * @param {object} result - `main` 里组装的结果。
 */
function printHuman(say, result) {
  for (const [label, report] of [['人设', result.persona], ['表达', result.style]]) {
    if (report === null) {
      say(`${label}  （文件不存在）`);
      say('');
      continue;
    }
    say(`${label}  ${report.path}  ${sizeLabel(report.bytes)}`);
    if (label === '人设') {
      const { counts } = report;
      const sceneText = Object.entries(counts.scenes).filter(([, count]) => count > 0).map(([key, count]) => `${({ private: '私聊', group: '群聊', proactive: '主动搭话', poke: '被戳一戳' })[key]} ${count}`).join(' / ');
      say(`  身份 ${counts.identity} 条 · 背景 ${counts.background} 条 · 性格 ${counts.traits} 条（启用 ${counts.enabled}：底色 ${counts.base} / 点缀 ${counts.accent}）${sceneText.length > 0 ? ` · 场景 ${sceneText}` : ''}`);
      say('  提示词预览（群聊场景，模型看到的就是这段）：');
      for (const line of report.preview) say(`    ${line}`);
    } else {
      say(`  总体 ${report.counts.general} / 标点 ${report.counts.punctuation} / 表情包 ${report.counts.sticker} / 私聊 ${report.counts.privateChat} / 群聊 ${report.counts.group}`);
      say('  提示词预览（群聊，按默认参数；实际以配置为准）：');
      for (const line of report.preview) say(`    ${line}`);
    }
    say('');
  }

  for (const level of ['error', 'warn', 'info']) {
    for (const item of result.findings.filter((entry) => entry.level === level)) {
      const mark = { error: '× 要改', warn: '! 建议', info: '· 说明' }[level];
      const where = { persona: '人设', style: '表达', cli: '自检' }[item.where] ?? item.where;
      say(`${mark}（${where}）：${item.message}`);
    }
  }
  if (result.findings.length > 0) say('');

  const errors = result.findings.filter((item) => item.level === 'error').length;
  const warns = result.findings.filter((item) => item.level === 'warn').length;
  if (errors > 0) say(`结论：还有 ${errors} 处要改${warns > 0 ? `、${warns} 条建议` : ''}。改完再跑一次。`);
  else if (warns > 0) say(`结论：可以用了；${warns} 条建议看完再决定改不改。`);
  else say('结论：可以用了（0 处要改）。');
}

/**
 * 主流程。
 * @returns {number} 退出码。
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`persona-check：${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const say = options.json ? (line = '') => console.error(line) : (line = '') => console.log(line);

  let personaFile;
  let styleFile;
  try {
    personaFile = readText(options.persona);
    styleFile = readText(options.style);
  } catch (error) {
    console.error(`persona-check：读不了文件：${error.message}`);
    return 2;
  }

  const findings = [];
  const personaMissing = personaFile.text === undefined;
  const styleMissing = styleFile.text === undefined;
  // 两个都不在时说一件事就够：分别说「人设没有」「表达没有」只是同一句话重复两遍。
  if (personaMissing && styleMissing) {
    findings.push(finding('error', 'cli', '两个文件都不在：现在跑的是内置人设 + 内置表达契约。先复制 deploy/persona/ 下的两份模板，再回来自检'));
  } else {
    if (personaMissing) {
      findings.push(finding('warn', 'persona', `没有 ${personaFile.path}：插件会用配置里的 persona，再没有就用内置人设。想写一份就从 deploy/persona/PERSONA.template.md 复制过去`));
    }
    if (styleMissing) {
      findings.push(finding('warn', 'style', `没有 ${styleFile.path}：插件会用内置表达契约。想要自己的口吻就从 deploy/persona/STYLE.template.md 复制过去`));
    }
  }

  const persona = checkPersona(personaFile);
  const style = checkStyle(styleFile, options.strict);
  findings.push(...persona.findings, ...style.findings);

  const result = {
    ok: findings.every((item) => item.level !== 'error'),
    strict: options.strict,
    persona: persona.report,
    style: style.report,
    findings,
  };

  printHuman(say, result);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

process.exitCode = main();
