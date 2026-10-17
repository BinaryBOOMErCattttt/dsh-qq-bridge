/**
 * `links.js` 的单元测试：卡片解析、SSRF 校验、只抓标题的受限抓取。
 *
 * 这里钉的主要是**拒绝方向**：一条 QQ 消息能把 URL 送进部署机器的网络里，所以每一种
 * 内网写法（本机名、私有网段、编码过的 IPv4、IPv6 内嵌 IPv4、重定向）都必须被挡住；
 * 抓取侧的假 fetch 只依赖最小形状 —— `{ status, headers, body }`，其中 `headers`
 * 可以是真 `Headers`（有 `get`），`body` 可以是真 `ReadableStream`。真 `Response`
 * 就满足，所以大部分用例直接构造它；只有「缺 content-type」「永远读不完的流」这两类
 * 边界才手写最小对象。
 *
 * 运行：node --test test/links.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkUrl, fetchPageTitle, pageTitle, parseCard, previewLine } from '../links.js';

/** 一段正常的 HTML 响应（title 在 head 里）。 */
const htmlResponse = (body, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) =>
  new Response(body, { status, headers: { 'content-type': contentType, ...headers } });

/** 一条 3xx 响应（没有 body）。 */
const redirectResponse = (location, status = 302) =>
  new Response(null, { status, headers: { location } });

test('parseCard：json 卡片提取标题/摘要/URL/站点，换行折叠并按上限截断', () => {
  const segment = {
    type: 'json',
    data: {
      data: JSON.stringify({
        prompt: '[QQ小程序]兜底提示',
        meta: {
          detail_1: {
            title: `${'标'.repeat(100)}\n第二行`,
            desc: '第一行\n第二行',
            qqdocurl: 'https://example.com/a?b=1',
            host: { nick: '示例站' },
          },
        },
      }),
    },
  };
  assert.deepEqual(parseCard(segment), {
    title: '标'.repeat(80),
    desc: '第一行 第二行',
    url: 'https://example.com/a?b=1',
    site: '示例站',
  });
});

test('parseCard：json 的 detail_2 / news / prompt 是兜底来源，xml 用正则取标签', () => {
  const detail2 = {
    type: 'json',
    data: { data: JSON.stringify({ meta: { detail_2: { title: '详情二', desc: '摘要二', jumpUrl: 'https://d2.example/x' } } }) },
  };
  assert.deepEqual(parseCard(detail2), { title: '详情二', desc: '摘要二', url: 'https://d2.example/x' });

  const news = {
    type: 'json',
    data: { data: JSON.stringify({ meta: { news: { title: '新闻', jumpUrl: 'https://news.example/n' } } }) },
  };
  assert.deepEqual(parseCard(news), { title: '新闻', url: 'https://news.example/n' });

  const promptOnly = { type: 'json', data: { data: JSON.stringify({ prompt: '只有提示' }) } };
  assert.deepEqual(parseCard(promptOnly), { title: '只有提示' });

  const xml = {
    type: 'xml',
    data: {
      data: '<msg serviceID="1" url="https://fallback.example/card"><item><title><![CDATA[XML 标题 &amp; 原文]]></title><summary>一行\n二行 &lt;三&gt;</summary></item><source name="示例来源"/></msg>',
    },
  };
  // CDATA 里是字面文本（XML 规定不解码实体），所以 `&amp;` 原样保留；
  // CDATA 之外的 `<summary>` 里 `&lt;三&gt;` 正常解码，换行折叠成空格。
  assert.deepEqual(parseCard(xml), {
    title: 'XML 标题 &amp; 原文',
    desc: '一行 二行 <三>',
    url: 'https://fallback.example/card',
    site: '示例来源',
  });

  const xmlWithUrl = {
    type: 'xml',
    data: { data: '<msg><item><title>带 URL</title><url>https://u.example/1</url></item></msg>' },
  };
  assert.deepEqual(parseCard(xmlWithUrl), { title: '带 URL', url: 'https://u.example/1' });
});

test('parseCard：畸形输入一律 undefined，且绝不抛错', () => {
  const badInputs = [
    undefined,
    null,
    {},
    { type: 'json' },
    { type: 'json', data: {} },
    { type: 'json', data: { data: '' } },
    { type: 'json', data: { data: '   ' } },
    { type: 'json', data: { data: '{坏 JSON' } },
    { type: 'json', data: { data: '[]' } },
    { type: 'json', data: { data: 'null' } },
    { type: 'json', data: { data: '{}' } },
    { type: 'xml', data: { data: '<msg></msg>' } },
    { type: 'xml', data: { data: 'not xml' } },
    { type: 'text', data: { data: '{}' } },
    { type: 'json', data: { data: 42 } },
  ];
  for (const input of badInputs) assert.equal(parseCard(input), undefined, JSON.stringify(input));

  // 只有站点名、没有标题/摘要/链接：没有任何可渲染的信息，按解析失败处理。
  const siteOnly = { type: 'json', data: { data: JSON.stringify({ meta: { host: { nick: '只有站点' } } }) } };
  assert.equal(parseCard(siteOnly), undefined);
});

test('checkUrl：只放行 http/https，其它 scheme 与坏 URL 都拒', () => {
  assert.equal(checkUrl('https://example.com/a').ok, true);
  assert.equal(checkUrl('http://example.com/a').ok, true);
  const cases = [
    ['ftp://example.com/a', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<title>x</title>', 'scheme'],
    ['//example.com/a', 'bad-url'],
    ['', 'bad-url'],
    ['   ', 'bad-url'],
    [undefined, 'bad-url'],
    [null, 'bad-url'],
    [42, 'bad-url'],
    ['example.com', 'bad-url'],
  ];
  for (const [raw, reason] of cases) {
    const result = checkUrl(raw);
    assert.equal(result.ok, false, String(raw));
    assert.equal(result.reason, reason, String(raw));
  }
});

test('checkUrl：拒绝 localhost、内网域名后缀与单标签主机', () => {
  for (const raw of ['http://localhost/', 'http://localhost:3000/', 'http://LOCALHOST/', 'http://localhost./', 'http://api.localhost/']) {
    assert.equal(checkUrl(raw).reason, 'localhost', raw);
  }
  for (const raw of ['http://a.local/', 'http://printer.LOCAL/', 'http://wiki.internal/', 'http://x.localdomain/', 'http://intranet/', 'http://nas/']) {
    assert.equal(checkUrl(raw).reason, 'internal-host', raw);
  }
});

test('checkUrl：拒绝私有/保留 IPv4 字面量，网段边界外侧放行', () => {
  const blocked = [
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1', '127.255.255.254',
    '169.254.169.254',
    '0.0.0.0', '0.1.2.3',
    '100.64.0.1', '100.127.255.254',
    '192.0.0.8',
    '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255',
  ];
  for (const host of blocked) assert.equal(checkUrl(`http://${host}/`).reason, 'private-ip', host);

  // 每个网段的边界外侧都是公网，不能误伤。
  const allowed = [
    '9.255.255.255', '11.0.0.1',
    '172.15.0.1', '172.32.0.1',
    '192.167.0.1', '192.169.0.1',
    '100.63.255.255', '100.128.0.1',
    '198.17.255.255', '198.20.0.1',
    '223.255.255.255',
  ];
  for (const host of allowed) assert.equal(checkUrl(`http://${host}/`).ok, true, host);
});

test('checkUrl：十进制/十六进制/八进制/短写形式的 IPv4 也要被认出来', () => {
  // WHATWG URL 会把这些形式归一成点分十进制，再走私有网段判定。
  for (const host of ['2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '127.1', '127.0.1', '0']) {
    assert.equal(checkUrl(`http://${host}/`).reason, 'private-ip', host);
  }
  // 十进制写的公网地址同样归一化后放行，说明归一化不是「一律拒绝数字」。
  const publicDecimal = checkUrl('http://134744072/'); // 8.8.8.8
  assert.equal(publicDecimal.ok, true);
  assert.equal(publicDecimal.host, '8.8.8.8');
});

test('checkUrl：拒绝 IPv6 本机/内网字面量（含内嵌 IPv4）', () => {
  const blocked = [
    '[::1]', '[::]', '[0:0:0:0:0:0:0:1]',
    '[fc00::1]', '[fd12:3456::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]',
    '[::7f00:1]',
    '[ff02::1]',
  ];
  for (const host of blocked) assert.equal(checkUrl(`http://${host}/`).reason, 'private-ip', host);

  // 公网 IPv6 放行（Cloudflare 的解析器地址，明确不是内网）。
  assert.equal(checkUrl('http://[2606:4700:4700::1111]/').ok, true);
});

test('checkUrl：放行公网地址并返回规范化后的 url/host', () => {
  assert.deepEqual(checkUrl('HTTPS://Example.COM/Path?q=1#frag'), {
    ok: true,
    url: 'https://example.com/Path?q=1#frag',
    host: 'example.com',
  });
  // 路径/查询串里的 @ 不是 userinfo，不该误伤。
  const atInPath = checkUrl('https://example.com/a@b?mail=x@y');
  assert.equal(atInPath.ok, true);
  assert.equal(atInPath.host, 'example.com');
});

test('checkUrl：拒绝 userinfo；allowPrivateHosts 只放开内网判定', () => {
  assert.equal(checkUrl('http://user:pass@example.com/').reason, 'userinfo');
  assert.equal(checkUrl('http://user@example.com/').reason, 'userinfo');

  assert.equal(checkUrl('http://127.0.0.1/').ok, false);
  assert.equal(checkUrl('http://127.0.0.1/', { allowPrivateHosts: true }).ok, true);
  assert.equal(checkUrl('http://localhost/', { allowPrivateHosts: true }).ok, true);
  assert.equal(checkUrl('http://intranet/wiki', { allowPrivateHosts: true }).ok, true);

  // scheme 与 userinfo 不受这个开关影响：内网开关不是「什么都能抓」的开关。
  assert.equal(checkUrl('ftp://127.0.0.1/', { allowPrivateHosts: true }).reason, 'scheme');
  assert.equal(checkUrl('http://user@127.0.0.1/', { allowPrivateHosts: true }).reason, 'userinfo');
  assert.equal(checkUrl('not a url', { allowPrivateHosts: true }).reason, 'bad-url');
});

test('fetchPageTitle：抓标题、逐跳跟随重定向、每次都用 manual 重新校验', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (seen.length === 1) return redirectResponse('/next', 301);
    if (seen.length === 2) return redirectResponse('https://other.example/final');
    return htmlResponse('<html><head><title> 最终 \n 标题 </title></head></html>');
  };
  const result = await fetchPageTitle('https://example.com/start', { fetchImpl });
  assert.deepEqual(result, { ok: true, title: '最终 标题', url: 'https://other.example/final', status: 200 });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].url, 'https://example.com/start');
  assert.equal(seen[1].url, 'https://example.com/next', '相对 location 要按当前 URL 解析');
  assert.equal(seen[2].url, 'https://other.example/final');
  for (const call of seen) assert.equal(call.options.redirect, 'manual', '重定向必须自己跟，不能交给 fetch');
});

test('fetchPageTitle：重定向指向内网时拒绝，超过 maxRedirects 也停', async () => {
  let privateCalls = 0;
  const privateJump = async () => {
    privateCalls += 1;
    return redirectResponse('http://127.0.0.1/latest/meta-data');
  };
  const blocked = await fetchPageTitle('https://example.com/', { fetchImpl: privateJump });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'redirect-private-ip');
  assert.equal(privateCalls, 1, '跳到内网那一步根本不该发出去');

  let loops = 0;
  const loopFetch = async () => {
    loops += 1;
    return redirectResponse('https://example.com/again');
  };
  const tooMany = await fetchPageTitle('https://example.com/', { fetchImpl: loopFetch, maxRedirects: 2 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.reason, 'redirects');
  assert.equal(loops, 3, '初始 1 次 + 跟 2 次，第 3 次重定向就该停');
});

test('fetchPageTitle：只接受 text/html 与 text/plain', async () => {
  const json = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => htmlResponse('{"title":"x"}', { contentType: 'application/json' }),
  });
  assert.equal(json.reason, 'content-type');

  const image = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => htmlResponse('', { contentType: 'image/png' }),
  });
  assert.equal(image.reason, 'content-type');

  // 缺 content-type：不能猜，一律拒。
  const missing = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => undefined },
      body: new Response('<title>x</title>').body,
    }),
  });
  assert.equal(missing.reason, 'content-type');

  const plain = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => htmlResponse('<title>纯文本</title>', { contentType: 'text/plain' }),
  });
  assert.equal(plain.ok, true);
  assert.equal(plain.title, '纯文本');
});

test('fetchPageTitle：读够大小上限就取消流；超时/非 2xx/网络异常只返回 reason', async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode(`<title>${'x'.repeat(4096)}</title>`);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const capped = await fetchPageTitle('https://example.com/', {
    // 手写最小响应：一个永远读不完的流，只有 `status` / `headers.get` / `body`。
    fetchImpl: async () => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body }),
    maxBytes: 64,
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'no-title', '标题在 64 字节之外，根本没读到');
  assert.equal(cancelled, true, '读够上限要取消流，不能把整页读完');

  // 假 fetch 尊重 abort 信号：只有这样才能证明超时真的传到了 fetch 的 signal 上。
  const hang = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const timedOut = await fetchPageTitle('https://example.com/', { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');

  const failed = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => htmlResponse('nope', { status: 503 }),
  });
  assert.deepEqual(failed, { ok: false, reason: 'status', status: 503 });

  const broken = await fetchPageTitle('https://example.com/', {
    fetchImpl: async () => {
      throw new TypeError('跑不通');
    },
  });
  assert.deepEqual(broken, { ok: false, reason: 'network' });

  // 初始 URL 就是内网：一个请求都不该发出去。
  let calls = 0;
  const inward = await fetchPageTitle('http://10.0.0.1/', {
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse('<title>不该到这</title>');
    },
  });
  assert.equal(inward.ok, false);
  assert.equal(inward.reason, 'private-ip');
  assert.equal(calls, 0);
});

test('pageTitle：<title> / og:title / 实体解码 / 折叠空白 / 120 字上限', () => {
  assert.equal(pageTitle('<html><head><title>  标题 \n 第二行 </title></head></html>'), '标题 第二行');
  assert.equal(pageTitle('<title>A &amp; B &lt;C&gt; &quot;q&quot; &#39;s&#x27; &#20320;</title>'), `A & B <C> "q" 's' 你`);
  assert.equal(pageTitle('<html><head><meta property="og:title" content="OG 标题"></head></html>'), 'OG 标题');
  // og:title 的属性顺序不固定，content 在 name 前面也要能取到。
  assert.equal(pageTitle('<meta content="属性顺序无关" name="og:title">'), '属性顺序无关');
  // 有 <title> 时优先用它，og:title 只是兜底。
  assert.equal(pageTitle('<meta property="og:title" content="OG"><title>真标题</title>'), '真标题');
  assert.equal(pageTitle(`<title>${'长'.repeat(200)}</title>`).length, 120);
  assert.equal(pageTitle('<title><![CDATA[CDATA 标题]]></title>'), 'CDATA 标题');
  assert.equal(pageTitle(''), undefined);
  assert.equal(pageTitle('<html></html>'), undefined);
  assert.equal(pageTitle(undefined), undefined);
});

test('previewLine：有标题才给一行，host 取最终 URL', () => {
  assert.equal(
    previewLine({ ok: true, title: '示例标题', url: 'https://example.com/a?b=1' }),
    '[链接: 【示例标题】 — example.com https://example.com/a?b=1]',
  );
  assert.equal(
    previewLine({ ok: true, title: '标题', url: 'http://[2606:4700:4700::1111]/x' }),
    '[链接: 【标题】 — [2606:4700:4700::1111] http://[2606:4700:4700::1111]/x]',
  );
  assert.equal(previewLine({ ok: false, reason: 'timeout' }), undefined);
  assert.equal(previewLine({ ok: true, title: '', url: 'https://example.com/' }), undefined);
  assert.equal(previewLine({ ok: true, title: '有标题没链接' }), undefined);
  assert.equal(previewLine(undefined), undefined);
});
