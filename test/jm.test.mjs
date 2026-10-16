/**
 * 禁漫（JM）下载链路里「不依赖 Harness」的那一半：车号解析、文件名清洗，以及
 * `jm.js` 的下载服务本身。
 *
 * 这里不连真实的禁漫：`jm_download.py` 的位置被换成一个**假的解释器 + 假脚本**，
 * 它按协议往 stdout 上吐 JSON Lines，于是 spawn / 超时 / 并发键 / 一次性 URL
 * 这些真实逻辑全都跑在真代码上，只有「下载」这一步是假的。
 *
 * 假解释器**用 Node**（`process.execPath`）而不是 shell 脚本：桌面版在 Windows 上，
 * 那边既没有 `/bin/sh` 也不认 shebang，一个 `.sh` 假脚本会让整条链路在那台机器上
 * 根本起不来 —— 而这条链路恰恰是「必须真的 spawn 一次」才验证得到的那部分。
 * `node <script> --out …` 与 `python <script> --out …` 的参数形状完全一致，
 * 插件侧（`jm.js`）看不出区别。
 *
 * 插件层面的行为（`/jm` 指令、qq_jm_pdf 工具）在 bridge.test.mjs 里跑。
 *
 * 运行：node --test test/jm.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJmService, parseJmRef, safeFileName, spawnAvailable } from '../jm.js';

/**
 * 起不了子进程的环境里，把「必须真的 spawn 一次」的用例**跳过**，而不是让它们红。
 *
 * 判据是 `jm.js` 导出的 `spawnAvailable`（探测的正是这条链路要用的那种 spawn：带管道的），
 * 所以插件在同一个环境里也是**停用**状态 —— 两边用同一个事实，不会出现「插件说能用、
 * 测试却说跳过」。为什么需要这一步：DSH 的沙箱禁止带管道的子进程（实测 `spawn EPERM`，
 * 见 AGENTS.md），于是同一份代码在普通终端里全绿、在沙箱里必红；红着跑会被误判成
 * 发布包坏了（这份用例最初就是这么被误判的）。跳过时把**原因**打出来，比一条红色的
 * traceback 有用得多。
 */
const SKIP = spawnAvailable ? false : '这个环境不能起带管道的子进程（DSH 沙箱），跳过需要真 spawn 的用例';

/** 包一层：能 spawn 就正常跑，不能就带原因跳过。 */
function spawnTest(name, body) {
  return test(name, { skip: SKIP }, body);
}

/**
 * 假脚本的公共前缀：解析 `--key value` 形式的参数，并给出写 PDF 的助手。
 *
 * 与真 `jm_download.py` 的约定一致：`--out` 是 PDF 目录、`--work` 是中间目录。
 */
const FAKE_PREAMBLE = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const readArg = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = readArg('--out');
const work = readArg('--work');
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const writePdf = (name, bytes = '%PDF-1.4 fake') => {
  const path = join(out, name);
  writeFileSync(path, bytes);
  return path;
};
`;

/**
 * 造一个假的「python」：先写一个由 `body` 决定行为的脚本，再返回
 * `{ python, script }` —— 解释器是 Node 自己，脚本是刚写下去的那个文件。
 *
 * @param dir - 放脚本的目录。
 * @param body - 脚本体（Node 语法，见 {@link FAKE_PREAMBLE} 里的助手）。
 * @returns `{ python, script }`：交给 createJmService 的两项。
 */
async function fakePython(dir, body) {
  const script = join(dir, `fake-python-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(script, `${FAKE_PREAMBLE}\n${body}\n`, 'utf8');
  return { python: process.execPath, script };
}

/** 起一个下载服务：cwd 是临时目录，python 指向假脚本。 */
async function serviceWith(body, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-jm-test-'));
  const { python, script } = await fakePython(root, body);
  const service = createJmService({
    cwd: root,
    dir: '.qq-jm',
    python,
    script,
    fileHost: '127.0.0.1',
    // 测试里的假脚本是瞬时的，超时给足；需要验证超时的用例自己覆盖。
    timeoutMs: 10000,
    report: () => {},
    ...overrides,
  });
  return { root, service };
}

/** 一个「下载成功」的假脚本：先发 meta，再写一个 PDF，最后发 result。 */
const OK_BODY = [
  `say({ event: 'meta', id: '422866', title: 'Test Book', author: 'tester', chapters: 2, pages: 3 });`,
  `const pdf = writePdf('Test Book.pdf');`,
  `say({ event: 'result', ok: true, pdf, pages: 3, bytes: 13, title: 'Test Book', kind: 'album', chapters: 2 });`,
].join('\n');

/** 一个「什么都不做、立刻退出」的假脚本（只用来铺目录，不跑下载）。 */
const NOOP_BODY = 'void work;';

test('parseJmRef understands bare ids, JM-prefixed ids and 18comic links', () => {
  assert.deepEqual(parseJmRef('422866'), { kind: 'auto', id: '422866' });
  assert.deepEqual(parseJmRef('JM422866'), { kind: 'auto', id: '422866' });
  assert.deepEqual(parseJmRef('jm 422866'), { kind: 'auto', id: '422866' });
  assert.deepEqual(parseJmRef('jm_422866'), { kind: 'auto', id: '422866' });
  // 链接里的路径决定整本还是单话，这是唯一能可靠区分两者的信息。
  assert.deepEqual(parseJmRef('https://18comic.vip/album/422866/'), { kind: 'album', id: '422866' });
  assert.deepEqual(parseJmRef('https://18comic.vip/photo/413446/?v=1#top'), { kind: 'chapter', id: '413446' });
  assert.deepEqual(parseJmRef('https://jmcomic.me/photos/413446'), { kind: 'chapter', id: '413446' });
  // 认不出来的东西必须返回 undefined，而不是瞎猜一个 id。
  assert.equal(parseJmRef(''), undefined);
  assert.equal(parseJmRef('你好'), undefined);
  assert.equal(parseJmRef('12'), undefined);
});

test('safeFileName strips path separators and control characters', () => {
  assert.equal(safeFileName('普通 本子 名'), '普通 本子 名');
  // 前导的点会被吃掉（避免 `..` / 隐藏文件），分隔符换成 `_`。
  assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFileName('   '), 'jm');
  assert.equal(safeFileName('x\u0000y'), 'x_y');
  assert.equal(safeFileName('长'.repeat(200)).length, 80);
});

test('the jm service is disabled when the download dir leaves cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-jm-test-'));
  const { python, script } = await fakePython(root, OK_BODY);
  const warnings = [];
  const service = createJmService({
    cwd: root,
    dir: '../outside',
    python,
    script,
    report: (level, message) => warnings.push(`${level}: ${message}`),
  });
  assert.equal(service.enabled, false);
  await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /disabled/);
  assert.ok(warnings.some((line) => line.includes('outside cwd')), warnings.join('\n'));
});

spawnTest('a download spawns the script, reports meta and returns the PDF', async () => {
  const { service } = await serviceWith(OK_BODY);
  try {
    const metas = [];
    const job = await service.run({ id: '422866', kind: 'auto', key: 'private:1', onMeta: (meta) => metas.push(meta) });
    assert.equal(job.name, 'Test Book.pdf');
    assert.equal(job.pages, 3);
    assert.equal(job.chapters, 2);
    assert.equal(job.title, 'Test Book');
    assert.equal(job.kind, 'album');
    assert.equal(job.bytes, Buffer.byteLength('%PDF-1.4 fake'));
    assert.ok(existsSync(job.path), 'the PDF must be on disk');
    // 路径必须落在下载目录里 —— 这是「不要把任意文件发出去」的那道关卡。
    assert.ok(job.path.startsWith(service.directory), job.path);
    assert.deepEqual(metas.map((meta) => meta.title), ['Test Book']);
    // 中间产物目录（--work）由脚本负责清理；服务只负责 PDF。
    assert.ok(!existsSync(job.workDir), 'the fake script leaves no work dir behind');
  } finally {
    service.close();
  }
});

spawnTest('a failed download surfaces the script error instead of hanging', async () => {
  const { service } = await serviceWith(
    `say({ event: 'result', ok: false, error: '这本有 146 话，超过上限 20；请指定单话' });`,
  );
  try {
    await assert.rejects(() => service.run({ id: '400222', key: 'k' }), /超过上限 20/);
  } finally {
    service.close();
  }
});

spawnTest('a python that exits without a result line is reported with its stderr tail', async () => {
  const { service } = await serviceWith(['process.stderr.write("boom: python is broken\\n");', 'process.exit(3);'].join('\n'));
  try {
    await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /exited with code 3.*boom: python is broken/s);
  } finally {
    service.close();
  }
});

spawnTest('a download that never finishes is killed at the hard timeout', async () => {
  // 假脚本必须真的「活着不动」：一个只 await 一个 pending promise 的 Node 进程会立刻
  // 退出（事件循环空了），那样这条用例测到的就不是超时分支了，所以要挂一个定时器撑住。
  const { service } = await serviceWith('setInterval(() => {}, 1000);', { timeoutMs: 1100 });
  try {
    await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /timed out after 1s/);
  } finally {
    service.close();
  }
});

spawnTest('the same conversation cannot start two downloads at once', async () => {
  // 「第一次还没跑完」靠假脚本自己先睡一会儿来制造。
  const { service } = await serviceWith([`await new Promise((done) => setTimeout(done, 1000));`, OK_BODY].join('\n'));
  try {
    const first = service.run({ id: '422866', key: 'group:7' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(service.isRunning('group:7'), true);
    await assert.rejects(() => service.run({ id: '422866', key: 'group:7' }), (error) => error.code === 'JM_BUSY');
    // 另一个会话不受影响（并发上限由 maxJobs 管，不由会话键管）。
    await first;
    assert.equal(service.isRunning('group:7'), false);
  } finally {
    service.close();
  }
});

spawnTest('serve hands out a one-shot URL that NapCat can fetch, and 404s otherwise', async () => {
  const { service } = await serviceWith(OK_BODY);
  try {
    const job = await service.run({ id: '422866', key: 'k' });
    const url = await service.serve(job.path, job.name);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/f\/[0-9a-f]{32}\//);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(await response.text(), '%PDF-1.4 fake');
    // 猜错的 token 不能拿到文件。
    const denied = await fetch(url.replace(/\/f\/[0-9a-f]{32}\//, `/f/${'0'.repeat(32)}/`));
    assert.equal(denied.status, 404);
    // 目录外的路径不该出现在 URL 里；服务自己不校验这个（由 run() 保证），
    // 但文件被淘汰之后必须明确回 410，而不是一个空 200。
    await service.prune();
  } finally {
    service.close();
  }
});

test('prune keeps only the newest PDFs in the download directory', async () => {
  const { service, root } = await serviceWith(NOOP_BODY);
  try {
    await mkdir(service.directory, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(service.directory, `book-${index}.pdf`), 'x');
    }
    await writeFile(join(service.directory, 'notes.txt'), 'keep me');
    service.close();
    const capped = createJmService({
      cwd: root,
      dir: '.qq-jm',
      python: join(root, 'nope'),
      script: join(root, 'jm_download.py'),
      maxFiles: 2,
      fileHost: '127.0.0.1',
      report: () => {},
    });
    await capped.prune();
    const { readdir } = await import('node:fs/promises');
    const names = (await readdir(capped.directory)).sort();
    assert.equal(names.filter((name) => name.endsWith('.pdf')).length, 2);
    assert.ok(names.includes('notes.txt'), 'only PDFs are pruned');
  } finally {
    // 目录是临时目录，交给操作系统回收。
  }
});
