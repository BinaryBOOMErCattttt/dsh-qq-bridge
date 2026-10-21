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

import { fetchBytes } from '../media.js';

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
