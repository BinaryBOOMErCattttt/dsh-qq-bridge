/**
 * `fetchBytes` 的重定向与校验器契约（SSRF 修复的单元层）。
 *
 * 出站图片（`image.js`）把「字面量 + DNS」检查作为 `validateUrl` 传进来；这个文件
 * 钉住两件事：每一跳都必须先过校验器，且 `redirect` 必须是手动的 —— 否则
 * 「公网 URL 302 到 127.0.0.1」这条最直接的绕过就没人挡。
 *
 * 用假的 `fetchImpl`，不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMediaStore, fetchBytes } from '../media.js';
import { buildGif } from './gif-fixtures.mjs';

/** 造一个够用的 Response 桩：`fetchBytes` 只读 status / headers / body。 */
function response({ status = 200, location, body = [1, 2, 3] } = {}) {
  const headers = new Headers();
  if (location !== undefined) headers.set('location', location);
  headers.set('content-length', String(body.length));
  return new Response(Buffer.from(body), { status, headers });
}

test('fetchBytes：每一跳都先过 validateUrl，且不把重定向交给 fetch', async () => {
  const calls = [];
  const seen = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    if (calls.length === 1) return response({ status: 302, location: 'http://next.example/img' });
    return response();
  };

  const bytes = await fetchBytes('http://start.example/img', {
    fetchImpl,
    validateUrl: async (url) => {
      seen.push(url);
      return url;
    },
  });

  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual(seen, ['http://start.example/img', 'http://next.example/img']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.redirect === 'manual'), '重定向必须自己跟');
});

test('fetchBytes：重定向目标被校验器拒绝时，不能真的去连它', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    return response({ status: 302, location: 'http://127.0.0.1/secret' });
  };

  await assert.rejects(
    () => fetchBytes('http://public.example/img', {
      fetchImpl,
      validateUrl: async (url) => {
        if (url.includes('127.0.0.1')) throw new Error('private address');
        return url;
      },
    }),
    /private address/,
  );
  assert.equal(calls.length, 1, '第一跳拿到 location 之后就中止，不能请求内网');
});

test('fetchBytes：重定向超过上限时拒绝，且只发上限 + 1 次请求', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ status: 302, location: `http://loop.example/${calls}` });
  };

  await assert.rejects(
    () => fetchBytes('http://loop.example/0', { fetchImpl, maxRedirects: 2 }),
    /too many redirects/,
  );
  assert.equal(calls, 3, '初始 1 次 + 2 次重定向；第 3 次 location 不再请求');
});

// ---------------------------------------------------------------------------
// 动图：落盘时顺手拆一张分镜图（模型那边只看得到第一帧，见 gif.js 的文件头）
// ---------------------------------------------------------------------------

test('media store：动图落盘时顺手生成分镜图，同一张图复用同一份', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-media-storyboard-'));
  try {
    const gif = buildGif({
      width: 8,
      height: 8,
      palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]],
      frames: [
        { width: 8, height: 8, indices: Array(64).fill(0), delayMs: 100 },
        { width: 8, height: 8, indices: Array(64).fill(1), delayMs: 100 },
        { width: 8, height: 8, indices: Array(64).fill(2), delayMs: 100 },
      ],
    });
    const source = join(cwd, 'anim.gif');
    await writeFile(source, gif);
    const store = createMediaStore({ cwd, dir: '.qq-media' });
    const first = await store.resolve({ kind: 'image', file: source });
    assert.equal(first.error, undefined);
    assert.ok(first.path.endsWith('.gif'));
    assert.equal(first.animation.frames, 3);
    assert.equal(first.animation.durationMs, 300);
    assert.equal(first.animation.shown, 3);
    assert.equal(first.animation.truncated, false);
    assert.ok(first.animation.path.endsWith('-frames.png'));
    const sheet = await readFile(join(cwd, first.animation.path));
    assert.equal(sheet.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    // 同一张动图再发一次：命中缓存，分镜图不重写，但两个文件都要刷新 mtime（LRU）。
    const again = await store.resolve({ kind: 'image', file: source });
    assert.equal(again.cached, true);
    assert.equal(again.animation.path, first.animation.path);
    assert.equal(again.animation.bytes, undefined, '复用时不重新编码');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('media store：静图 GIF 不生成分镜图', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-media-static-'));
  try {
    const gif = buildGif({ width: 8, height: 8, palette: [[255, 0, 0]], frames: [{ width: 8, height: 8, indices: Array(64).fill(0) }] });
    const source = join(cwd, 'still.gif');
    await writeFile(source, gif);
    const store = createMediaStore({ cwd, dir: '.qq-media' });
    const outcome = await store.resolve({ kind: 'image', file: source });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.animation, undefined);
    const files = await readdir(join(cwd, '.qq-media'));
    assert.equal(files.filter((name) => name.endsWith('.png')).length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('media store：拆帧失败只记 warn，GIF 本身照常落盘', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-media-broken-'));
  try {
    const gif = buildGif({
      width: 8,
      height: 8,
      palette: [[255, 0, 0], [0, 255, 0]],
      frames: [
        { width: 8, height: 8, indices: Array(64).fill(0) },
        { width: 8, height: 8, indices: Array(64).fill(1) },
      ],
    });
    // 砍掉尾部：结构解析会失败，但字节仍是合法的 GIF 开头，落盘这一步不该受影响。
    const source = join(cwd, 'cut.gif');
    await writeFile(source, gif.subarray(0, gif.length - 4));
    const warnings = [];
    const store = createMediaStore({ cwd, dir: '.qq-media', report: (level, message) => warnings.push([level, message]) });
    const outcome = await store.resolve({ kind: 'image', file: source });
    assert.equal(outcome.error, undefined, '图还是要发出去的');
    assert.ok(outcome.path.endsWith('.gif'));
    assert.equal(outcome.animation, undefined);
    assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('storyboard')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
