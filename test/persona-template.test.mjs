/**
 * `deploy/persona/` 与 `docs/persona-workshop.md` 的契约测试。
 *
 * 这套东西的价值全在「模板本身是干净的」：部署者复制过去、改四处就能用，所以模板必须
 *   1. **零解析警告** —— 有一行写歪，用户复制到的就是一行被静默丢掉的人设；
 *   2. **STYLE 零体检命中** —— 模板自己不能带客服腔 /「自然一点」/ 逗号配额这些坑；
 *   3. **人设只有一条底色、至少留一条停用的点缀** —— 前者是硬规则，后者是「怎么改」的示例；
 *   4. **长度不超默认上限** —— 抄过去就被 `personaMaxChars` / `styleMaxChars` 截断的模板没有意义；
 *   5. **文档里的路径真的存在** —— 提示词与文档是部署者唯一的入口，链接烂了等于没有。
 *
 * 另外钉住 `scripts/persona-check.mjs` 的退出码语义：干净 = 0、要改 = 1、`--strict` 把体检
 * 升级成要改。这个脚本是「写完自检」的唯一反馈渠道，退出码反了，CI 与 agent 都会读错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parsePersonaDoc, renderPersona } from '../persona.js';
import { lintStyleDoc, parseStyleDoc, renderStyleContract } from '../style.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PERSONA_TEMPLATE = 'deploy/persona/PERSONA.template.md';
const STYLE_TEMPLATE = 'deploy/persona/STYLE.template.md';
const PROMPT = 'deploy/persona/PROMPT.md';
const WORKSHOP = 'docs/persona-workshop.md';
const CHECKER = 'scripts/persona-check.mjs';

const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** 跑一次自检脚本，返回 `{ status, stdout, stderr }`（`--json` 时 stdout 只有一个对象）。 */
function runChecker(args, cwd = root) {
  const result = spawnSync(process.execPath, [join(root, CHECKER), ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('人设模板：零警告、只有一条底色、保留停用示例', () => {
  const { profile, warnings } = parsePersonaDoc(read(PERSONA_TEMPLATE));
  assert.deepEqual(warnings, [], '模板本身不能有解析警告');

  const keys = profile.identity.map((pair) => pair.key);
  assert.ok(keys.includes('名字'), '模板必须示范「名字」这一行');
  assert.ok(keys.includes('与群的关系'), '模板必须示范「与群的关系」');

  const enabled = profile.traits.filter((trait) => trait.enabled);
  const base = enabled.filter((trait) => trait.role === 'base');
  assert.equal(base.length, 1, '底色只能一条 —— 模板自己先守住这条');
  assert.ok(profile.traits.some((trait) => !trait.enabled), '留一条 [ ] 的点缀当「怎么改」的示例');
  assert.ok(profile.traits.length >= 3, '至少给用户几种可选的点缀');

  for (const scene of ['private', 'group', 'proactive', 'poke']) {
    assert.ok(profile.scenes[scene].length > 0, `场景「${scene}」不能空着 —— 四大场景是模板的卖点之一`);
  }
  assert.ok(profile.background.length >= 2, '背景至少两条：喜好 + 最近');

  // 渲染出来必须真的有内容，而且四个场景都能渲染（否则等于复制了一份空人设）。
  for (const scene of ['private', 'group', 'proactive', 'poke']) {
    const lines = renderPersona(profile, { scene });
    assert.ok(lines.length > 0);
    assert.ok(lines.some((line) => line.includes('【底色｜始终在场】')), '渲染结果里必须有底色');
  }
  assert.ok(read(PERSONA_TEMPLATE).length <= 4000, '模板不能超过 personaMaxChars 的默认值');
});

test('表达模板：零警告、零体检命中、不带会读进提示词的 HTML 注释', () => {
  const text = read(STYLE_TEMPLATE);
  const { prose, warnings } = parseStyleDoc(text);
  assert.deepEqual(warnings, [], '模板本身不能有解析警告');
  // STYLE.md 的解析不跳过 HTML 注释：注释会被当成规则读进去，所以模板里一条都不能有。
  assert.ok(!text.includes('<!--'), 'STYLE 模板里不能放 HTML 注释（会被当成规则）');

  for (const section of ['general', 'punctuation', 'sticker', 'privateChat', 'group']) {
    assert.ok(prose[section].length > 0, `「${section}」不能空着`);
  }
  assert.deepEqual(lintStyleDoc(prose), [], '模板自己不能踩人机感体检的坑');

  const contract = renderStyleContract({
    prose,
    params: { stripShortPeriod: true, shortPeriodMaxChars: 40, humanize: true },
    scene: 'group',
    imageAllowed: true,
  });
  assert.ok(contract.length > 0);
  assert.ok(contract.some((line) => line.includes('多数句子不带逗号')), '逗号要讲频率（示例必须留在模板里）');
  assert.ok(text.length <= 2000, '模板不能超过 styleMaxChars 的默认值');
});

test('提示词：18 道题都在，且给出了落盘与自检的硬要求', () => {
  const prompt = read(PROMPT);
  // 只拆「问卷」那一节：文件里还有别的编号列表（怎么用、第三步），一起数会数错。
  const bank = prompt.split('【问卷 · 18 题】')[1].split('【第三步】')[0];
  const blocks = bank.split(/\n(?=\d+\. )/).filter((block) => /^\d+\. /.test(block));
  assert.equal(blocks.length, 18, '问卷必须是 18 题');
  for (const [index, block] of blocks.entries()) {
    // 每题都必须留「我自己写」的出口，且第一个选项是推荐项 —— 这两条是「不会卡住」的全部保证。
    assert.ok(block.includes('我自己写'), `第 ${index + 1} 题没有「我自己写」这个出口`);
    const firstOption = block.split('\n').slice(1).find((line) => /^\s+[A-G][（ ]/.test(line));
    assert.ok(firstOption !== undefined, `第 ${index + 1} 题看不出选项`);
    assert.ok(firstOption.includes('（推荐）'), `第 ${index + 1} 题的第一个选项没标（推荐）`);
  }
  // 几条不能丢的约束：先问怎么问、只动两个文件、配置项只列出来不代改。
  assert.match(prompt, /一次答完还是一题一题来/);
  assert.match(prompt, /只动 `\.qq-persona\/PERSONA\.md` 与 `\.qq-persona\/STYLE\.md`/);
  assert.match(prompt, /不要动 `cordis\.patch\.yml`/);
  assert.match(prompt, /node scripts\/persona-check\.mjs/);
  // 「还没写就先问」的默认值兜底：不会因为用户答「随便」卡住。
  assert.match(prompt, /按推荐项走/);
});

test('文档不失链：模板、提示词、自检脚本、README 都指得到', () => {
  const workshop = read(WORKSHOP);
  for (const target of [PERSONA_TEMPLATE, STYLE_TEMPLATE, PROMPT, CHECKER]) {
    const name = target.split('/').pop();
    assert.ok(workshop.includes(name), `docs/persona-workshop.md 里没有提到 ${name}`);
  }
  assert.ok(read('README.md').includes('docs/persona-workshop.md'), 'README 的文档地图里要能点进来');
  assert.ok(read('docs/persona-style.md').includes('persona-workshop.md'), '人格与表达分册要指路');
  // 提示词里给部署者的两个相对链接（从 deploy/persona/ 出发）必须是真的。
  const prompt = read(PROMPT);
  assert.ok(prompt.includes('(../../docs/persona-workshop.md)'), '提示词里回工作坊的链接层级要对');
  assert.ok(prompt.includes('(PERSONA.template.md)'));
});

test('自检脚本：模板本身退出码 0，且 JSON 里没有 error', () => {
  const { status, stdout } = runChecker(['--persona', PERSONA_TEMPLATE, '--style', STYLE_TEMPLATE, '--json']);
  assert.equal(status, 0, '干净的模板不该被判成「要改」');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.findings.filter((item) => item.level === 'error').length, 0);
  assert.equal(result.persona.counts.base, 1);
  assert.deepEqual(result.style.lint, []);
});

test('自检脚本：写歪的文件退出码 1，并点名具体问题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-persona-'));
  try {
    writeFileSync(join(dir, 'PERSONA.md'), '# 人设\n\n## 身份\n- 名字：小栞\n\n## 性格\n- [x] 温柔｜底色｜0.8｜任何时候｜软\n- [x] 活泼｜底色｜0.8｜任何时候｜热\n\n## 人格\n- 这条节名写错了\n');
    writeFileSync(join(dir, 'STYLE.md'), '## 总体\n- 语气自然一点，像真人。\n');
    const { status, stdout } = runChecker(['--persona', join(dir, 'PERSONA.md'), '--style', join(dir, 'STYLE.md'), '--json']);
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    const messages = result.findings.map((item) => item.message).join('\n');
    assert.match(messages, /不认识的节「人格」/);
    assert.match(messages, /多条底色/);
    assert.match(messages, /自然一点/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检脚本：--strict 才把 STYLE 体检升级成要改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-persona-'));
  try {
    writeFileSync(join(dir, 'PERSONA.md'), read(PERSONA_TEMPLATE));
    writeFileSync(join(dir, 'STYLE.md'), '## 总体\n- 一句里逗号最多一个。\n\n## 标点\n- 短句句末不加「。」。\n');
    const args = ['--persona', join(dir, 'PERSONA.md'), '--style', join(dir, 'STYLE.md'), '--json'];
    assert.equal(runChecker(args).status, 0, '默认只把体检当建议');
    assert.equal(runChecker([...args, '--strict']).status, 1, '--strict 下体检命中要退出 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
