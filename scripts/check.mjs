#!/usr/bin/env node
/**
 * 静态检查：文档一致性 + 全仓库 `node --check` 语法。
 *
 * 为什么需要它：这个仓库没有构建步骤，`node --test test/` 又依赖宿主注入的
 * `@deepseek-ai/*` peer 包 —— 在 CI / 一台干净的机器上，最容易先坏掉的是
 * 「文档与 schema 漂移」和「某个文件语法错误」，而不是业务逻辑。这个脚本零依赖，
 * 不 import 插件模块，所以任何环境都能跑。
 *
 * 检查项：
 *   1. `AGENTS.md` 不超过 DSH 的 65536 字节注入预算（超了会被静默截断，后面的规则
 *       Agent 根本看不到 —— 真实踩过一次）。
 *   2. `config.js` 的每一个顶层字段都出现在 `docs/configuration.md` 的配置表里。
 *      「加配置项要同步三处」只靠人记必然漏；这就是那条漏掉时的红灯。
 *   3. `docs/agents/data-flows.md` 还在（AGENTS.md §4 被拆出去后，索引不能指向空）。
 *   4. 所有被 git 跟踪的 `.js` / `.mjs` 都能通过 `node --check`（不执行）。
 *
 * 用法：`node scripts/check.mjs`（`npm run check` 会先跑它再跑测试）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_LIMIT = 65536;

const failures = [];

function fail(message) {
  failures.push(message);
}

// 1) AGENTS.md 注入预算 -------------------------------------------------------
const agentsPath = join(ROOT, 'AGENTS.md');
if (!existsSync(agentsPath)) {
  fail('AGENTS.md 不存在');
} else {
  const bytes = statSync(agentsPath).size;
  if (bytes > AGENTS_LIMIT) {
    fail(
      `AGENTS.md 是 ${bytes} 字节，超过 ${AGENTS_LIMIT} 的注入预算；` +
        '超出部分会被 DSH 静默截断（§4 的完整正文应留在 docs/agents/data-flows.md）',
    );
  }
}

// 2) config.js ↔ docs/configuration.md --------------------------------------
const configPath = join(ROOT, 'config.js');
const docsPath = join(ROOT, 'docs', 'configuration.md');
if (!existsSync(configPath) || !existsSync(docsPath)) {
  fail('config.js 或 docs/configuration.md 不存在');
} else {
  const configSource = readFileSync(configPath, 'utf8');
  const keys = [...configSource.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*): z\./gm)].map((match) => match[1]);
  if (keys.length === 0) fail('config.js 里一个顶层字段都没解析出来（正则失配？）');

  const docSource = readFileSync(docsPath, 'utf8');
  const mentioned = new Set();
  for (const line of docSource.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const match of line.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) mentioned.add(match[1]);
  }
  const missing = keys.filter((key) => !mentioned.has(key));
  if (missing.length > 0) {
    fail(
      `docs/configuration.md 的配置表缺少 ${missing.length} 个字段：${missing.join(', ')}` +
        '（config.js 是唯一真相；加字段时表格要同步）',
    );
  }
}

// 3) AGENTS §4 的完整正文还在 ------------------------------------------------
if (!existsSync(join(ROOT, 'docs', 'agents', 'data-flows.md'))) {
  fail('docs/agents/data-flows.md 不存在：AGENTS.md §4 的索引会指向空');
}

// 4) 语法检查（只跟踪仓库里的文件，绝不扫 node_modules / NapCat 二进制） --------
const SKIP_DIRS = new Set(['node_modules', 'NapCat.Shell', 'dist', '.git', '.qq-jm', '.qq-media', '.qq-memory', '.qq-stickers', '.venv']);
const checked = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
      walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extname(entry.name) !== '.js' && extname(entry.name) !== '.mjs') continue;
    checked.push(absolute);
  }
}

// `readdirSync` 与其它 fs 函数一起在顶部 import；walk 只读目录，不碰插件模块。
walk(ROOT);
for (const file of checked) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split('\n').slice(0, 3).join(' ');
    fail(`node --check 失败：${relative(ROOT, file)} — ${detail}`);
  }
}

// 汇总 ----------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`静态检查失败（${failures.length} 项）：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`静态检查通过：AGENTS.md ${statSync(agentsPath).size} 字节，${checked.length} 个 JS 文件语法正常。`);
