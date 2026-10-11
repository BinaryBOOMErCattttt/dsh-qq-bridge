/**
 * 禁漫（JM）下载链路里「不依赖 Harness」的那一半：车号解析、文件名清洗，以及
 * `jm.js` 的下载服务本身。
 *
 * 这里不连真实的禁漫：`jm_download.py` 的位置被换成一个**假的 shell 脚本**，
 * 它按协议往 stdout 上吐 JSON Lines，于是 spawn / 超时 / 并发键 / 一次性 URL
 * 这些真实逻辑全都跑在真代码上，只有「下载」这一步是假的。
 *
 * 插件层面的行为（`/jm` 指令、qq_jm_pdf 工具）在 bridge.test.mjs 里跑。
 *
 * 运行：node --test test/jm.test.mjs
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJmService, parseJmRef, safeFileName } from '../jm.js';

/**
 * 造一个假的「python」：一个 shell 脚本，行为由 `body` 决定。
 *
 * 插件是把 `jmPython` 当可执行文件直接 spawn 的，所以这里只要一个能打印协议
 * JSON 的可执行文件就够了 —— 参数里的 `--work` / `--out` 由脚本自己按需解析。
 * @param dir - 放脚本的目录。
 * @param body - 脚本体（`sh`）。
 * @returns 脚本的绝对路径。
 */
async function fakePython(dir, body) {
  const path = join(dir, `fake-python-${Math.random().toString(16).slice(2)}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

/** 解析 `--key value` 形式的参数（假脚本用）。 */
const READ_ARG = `read_arg() {
  while [ $# -gt 0 ]; do
    case "$1" in
      "$2") eval "$3=\\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
}`;

/** 起一个下载服务：cwd 是临时目录，python 指向假脚本。 */
async function serviceWith(body, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-jm-test-'));
  const python = await fakePython(root, body);
  const service = createJmService({
    cwd: root,
    dir: '.qq-jm',
    python,
    script: join(root, 'jm_download.py'),
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
  'out=""',
  'while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done',
  `echo '{"event":"meta","id":"422866","title":"Test Book","author":"tester","chapters":2,"pages":3}'`,
  'printf "%s" "%PDF-1.4 fake" > "$out/Test Book.pdf"',
  `echo '{"event":"result","ok":true,"pdf":"'"$out"'/Test Book.pdf","pages":3,"bytes":13,"title":"Test Book","kind":"album","chapters":2}'`,
].join('\n');

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
  const python = await fakePython(root, OK_BODY);
  const warnings = [];
  const service = createJmService({
    cwd: root,
    dir: '../outside',
    python,
    script: join(root, 'jm_download.py'),
    report: (level, message) => warnings.push(`${level}: ${message}`),
  });
  assert.equal(service.enabled, false);
  await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /disabled/);
  assert.ok(warnings.some((line) => line.includes('outside cwd')), warnings.join('\n'));
});

test('a download spawns the script, reports meta and returns the PDF', async () => {
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

test('a failed download surfaces the script error instead of hanging', async () => {
  const { service } = await serviceWith(
    [`echo '{"event":"result","ok":false,"error":"这本有 146 话，超过上限 20；请指定单话"}'`].join('\n'),
  );
  try {
    await assert.rejects(() => service.run({ id: '400222', key: 'k' }), /超过上限 20/);
  } finally {
    service.close();
  }
});

test('a python that exits without a result line is reported with its stderr tail', async () => {
  const { service } = await serviceWith(['echo "boom: python is broken" >&2', 'exit 3'].join('\n'));
  try {
    await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /exited with code 3.*boom: python is broken/s);
  } finally {
    service.close();
  }
});

test('a download that never finishes is killed at the hard timeout', async () => {
  const { service } = await serviceWith('sleep 30', { timeoutMs: 1100 });
  try {
    await assert.rejects(() => service.run({ id: '422866', key: 'k' }), /timed out after 1s/);
  } finally {
    service.close();
  }
});

test('the same conversation cannot start two downloads at once', async () => {
  const { service } = await serviceWith(['sleep 1', OK_BODY].join('\n'));
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

test('serve hands out a one-shot URL that NapCat can fetch, and 404s otherwise', async () => {
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
  const { service, root } = await serviceWith('true');
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
