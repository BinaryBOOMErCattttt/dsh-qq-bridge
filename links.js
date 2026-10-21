/**
 * 链接与卡片（感知层「链接」那一路）：卡片解析 + 只抓标题的受限抓取。
 *
 * **抓到的标题是不可信数据。** 卡片来自 QQ 消息（发消息的人想写什么都行），标题则
 * 来自一个由他指定的网页。调用方只能把它当成一段文字渲染（{@link previewLine} 给出的
 * `[链接: 【标题】 — host url]` 就是这个用途），**绝不能**把它拼进提示词当指令，更不能
 * 因为它写了什么就去执行什么。页面里的 `<title>` 同理 —— 那只是别人网页上的一行字。
 *
 * 抓取是**可选**的（`linkPreview` 默认关）：替群友访问任意 URL，等于把部署机器的出口
 * IP 借给发链接的人，还会变成一次可被用来探测的请求。卡片自带的 title/desc 不联网就
 * 够用了，要预览再显式打开。
 *
 * 零依赖：只用 Node 的全局 `URL` / `TextDecoder` / `TextEncoder` / `fetch` /
 * `AbortController`，一行 import 都没有。QQ 卡片 XML 的结构就那几个标签，为它引入
 * 一个 XML 解析器（或任何 npm 依赖）不值得；而且正则对畸形输入只需要「返回
 * undefined」，比让解析器抛异常更好收场。
 *
 * 已知边界（刻意如此）：{@link checkUrl} 是同步的纯函数，只拦**字面量**与本机名。
 * 一个公网域名解析到内网 IP（DNS rebinding）它看不出来 —— 真要连解析出的 IP 得在
 * 连接层固定地址，那是另一件事。抓取侧能补的那一半已经补了：**每一跳重定向都重新
 * 校验**（见 {@link fetchPageTitle}），所以「公网跳内网」这条最直接的绕过是挡住的。
 *
 * @module @qqbot/dsh-plugin-qq/links
 */

/** 标题最多留多少字（模型读得懂一行就够，太长会挤掉正文）。 */
const TITLE_MAX = 80;

/** 摘要最多留多少字。 */
const DESC_MAX = 160;

/** 站点名（群名片类的小字段）最多留多少字。 */
const SITE_MAX = 40;

/** URL 最多留多少字：只挡「几 KB 的签名串把上下文撑爆」这种极端情况。 */
const URL_MAX = 2048;

/** 页面标题最多留多少字（`pageTitle` 用，比卡片标题宽一点）。 */
const PAGE_TITLE_MAX = 120;

/**
 * 解析 OneBot 的 `json` / `xml` 卡片段。
 *
 * 两类卡片都只取「卡面自带」的信息，**不联网**：
 *   - `json`：`data.data` 是一段 JSON 字符串，标题/摘要/链接/站点散在
 *     `prompt`、`meta.detail_1` / `detail_2` / `news` / `meta` 自己身上；
 *   - `xml`：`data.data` 是一段 XML 字符串，用正则取 `<title>` / `<summary>`
 *     / `<url>`（以及根 `<msg url="…">`、`<source name="…">` 这两个常见兜底）。
 *
 * 「绝不抛错」是契约的一部分：这个函数的调用点在消息渲染里，一条坏卡片不能带走
 * 整条消息。解析不出任何标题/摘要/链接时返回 undefined，调用方退回流渲染的
 * `[卡片消息]` 即可。
 *
 * 返回的字段全部是**数据**：只做过 trim / 换行折叠 / 长度截断，没有做任何解释。
 *
 * @param {{ type?: string, data?: { data?: unknown } } | undefined} segment - 一个消息段。
 * @returns {{ title?: string, desc?: string, url?: string, site?: string } | undefined}
 *   只包含真正解析出来的字段；一个都没有时 undefined。
 */
export function parseCard(segment) {
  try {
    if (!isPlainObject(segment)) return undefined;
    const { type, data } = segment;
    // 只认 `data.data` 是字符串的形态：少数实现会把它塞成对象，那种情况交给调用方
    // 退回 `[卡片消息]`，别在这里猜结构。
    if (!isPlainObject(data) || typeof data.data !== 'string') return undefined;
    if (data.data.trim() === '') return undefined;
    if (type === 'json') return parseJsonCard(data.data);
    if (type === 'xml') return parseXmlCard(data.data);
    return undefined;
  } catch {
    // JSON.parse 已经单独兜过；这里再兜一层，防的是「正则/取属性」遇上没预料到的形状。
    // 坏卡片只该变成一行 `[卡片消息]`，不该把整条 QQ 消息的渲染炸掉。
    return undefined;
  }
}

/**
 * 校验一个 URL 是否适合由插件替别人去访问（SSRF 防护）。
 *
 * 规则分三层，**顺序就是判定的优先级**：
 *   1. 只放行 `http:` / `https:`；带凭据（`user:pass@`）的一律拒 —— 那个 `@` 会让
 *      「看起来是谁」和「实际连到哪」不一致。判定用的是 URL 解析出来的
 *      `username` / `password`，不是在原文里找 `@`：路径和查询串里合法地会有 `@`，
 *      按字符找会误伤（`/a@b`、`?mail=x@y`）。
 *   2. 主机名：`localhost`、`*.localhost`、`*.local`、`*.internal`、`*.localdomain`、
 *      以及**没有点的单标签主机**（`intranet`、`nas`、`wiki`）都算内网。
 *   3. IP 字面量：私有/保留 IPv4 网段、IPv6 的本机/唯一本地/链路本地/组播，以及
 *      IPv4-mapped / IPv4-compatible 的 `::ffff:a.b.c.d`（把内嵌的 v4 抠出来再按
 *      第 3 层判一遍）。
 *
 * 十进制/十六进制/八进制/短写形式的 IPv4（`2130706433`、`0x7f.0.0.1`、`0177.0.0.1`、
 * `127.1`）先交给 WHATWG URL 解析器归一化，再走第 3 层；万一有实现漏了归一化，
 * 还有一个「看起来就是纯数字/0x 标签」的兜底，绝不让它落进「域名」那一支。
 *
 * `allowPrivateHosts: true` 只跳过第 2、3 层（内网/保留地址），**永远不跳过**第 1 层
 * （scheme 与凭据）—— 内网 wiki 是确实存在的需求，`file:` 不是。
 *
 * 返回的 `reason` 是给调用方/日志用的机器可读码：
 * `bad-url` | `scheme` | `userinfo` | `localhost` | `internal-host` | `private-ip`。
 *
 * @param {unknown} raw - 待校验的原始 URL 字符串（来自 QQ，不可信）。
 * @param {{ allowPrivateHosts?: boolean }} [options] - 是否显式放开内网地址。
 * @returns {{ ok: boolean, url?: string, host?: string, reason?: string }}
 *   `ok:true` 时 `url` 是归一化后的地址（fetch 用它），`host` 是去掉 IPv6 方括号与
 *   FQDN 结尾点的小写主机名；失败时只给 `reason`。
 */
export function checkUrl(raw, options = {}) {
  // 显式传 null 也不该炸：这个函数会被「已经拿到一段不可信数据」的代码顺手调用。
  const { allowPrivateHosts = false } = options ?? {};
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'bad-url' };
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  // 凭据一律拒：`http://user:pass@host/` 里的 `@` 会让「看起来是谁」和「实际连到哪」不一致。
  // 用解析后的 username/password 判定，而不是在原文里找 `@`：路径与查询串里合法地会有它。
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo' };
  const hostname = parsed.hostname;
  if (hostname === '') return { ok: false, reason: 'bad-url' };
  const reason = hostReason(hostname);
  // `bad-url` 不属于「内网判定」，所以不受 allowPrivateHosts 影响。
  if (reason === 'bad-url') return { ok: false, reason };
  if (reason !== undefined && !allowPrivateHosts) return { ok: false, reason };
  return {
    ok: true,
    url: parsed.href,
    // 展示用的 host：去掉 IPv6 的方括号与 FQDN 的结尾点，统一小写。
    // 注意这里保留的只是「给人看的主机名」，安全判定已经在上面按 hostname 做完。
    host: hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '').toLowerCase(),
  };
}

/**
 * 从一段 HTML 里取页面标题：先 `<title>`，没有再找 `og:title`。
 *
 * 只做「读一行字」这件事：不解码 charset（调用方已经按 utf-8/latin-1 解完）、
 * 不执行任何东西、不抓正文。实体只解最基础的几个（`&amp; &lt; &gt; &quot; &#39;`
 * 与数字实体）—— 解多了反而会把页面里本来想显示的 `&amp;` 弄丢。
 *
 * 返回值是**数据**：调用方只能把它当标题文本渲染，不能当指令。
 *
 * @param {unknown} html - 已解码的 HTML/纯文本。
 * @returns {string | undefined} 折叠空白、最多 120 字；没有标题时 undefined。
 */
export function pageTitle(html) {
  if (typeof html !== 'string' || html === '') return undefined;
  let raw = '';
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (title) raw = title[1];
  if (raw.trim() === '') {
    // og:title 是给分享卡片用的；不少站点（或 SPA 的静态壳）只在 meta 里写标题。
    // 属性顺序不固定，所以逐个 <meta> 取出 property/name 与 content 自己配对。
    const meta = /<meta\b[^>]*>/gi;
    let match;
    while ((match = meta.exec(html)) !== null) {
      const key = attrValue(match[0], 'property') ?? attrValue(match[0], 'name');
      if (typeof key === 'string' && key.trim().toLowerCase() === 'og:title') {
        const content = attrValue(match[0], 'content');
        if (typeof content === 'string' && content.trim() !== '') {
          raw = content;
          break;
        }
      }
    }
  }
  if (raw === '') return undefined;
  const text = capText(decodeMarkupText(raw), PAGE_TITLE_MAX);
  return text === '' ? undefined : text;
}

/**
 * 抓一个 URL 的标题（只抓标题，不抓正文、不执行 JS）。
 *
 * 抓取顺序与边界：
 *   - 初始 URL 先过 {@link checkUrl}；**每一跳重定向都重新过一遍**，因为
 *     `location` 同样来自那个不可信的链接，可以指向 `127.0.0.1`；
 *   - 用 `redirect: 'manual'` 自己跟（默认最多 3 跳），这样每一跳都看得到；
 *   - 只接受 `text/html` / `text/plain`（按 `content-type`）；别的类型（图片、JSON、
 *     缺头）一律不读；
 *   - 整个抓取共用一个 `AbortController`，`timeoutMs` 一到就中止；
 *   - 最多读 `maxBytes`（按流读、读够就 `cancel()`），**绝不把无界 body 整块吞下**；
 *   - 解码按 utf-8，只有明确写了 latin-1/iso-8859-1 才换（GBK 之类不猜，宁可看到
 *     替换字符也不乱认）。
 *
 * 任何失败都返回 `{ ok:false, reason }`，**绝不抛错**。`reason` 的取值：
 * `scheme` | `userinfo` | `localhost` | `internal-host` | `private-ip` | `bad-url`
 * （初始 URL 校验失败）；`redirect-<上面的码>`（重定向目标被拒）；`redirect`（3xx
 * 没有 location）；`redirects`（超过 maxRedirects）；`status`（非 2xx）；
 * `content-type`；`no-title`；`timeout`；`network`。
 *
 * 返回的 `title` 是**数据**：调用方只能渲染，不能当指令（见模块注释）。
 *
 * 注入的 `fetchImpl` 只依赖一个最小形状：返回 `{ status, headers, body? }`，其中
 * `headers` 可以是真 `Headers`（有 `get(name)`）或普通对象，`body` 可以是真
 * `ReadableStream`（`getReader()` 给出 `{ read(), cancel() }`，chunk 为
 * `Uint8Array`）或直接给字符串/字节。真 `fetch` 的响应天然满足。
 *
 * @param {unknown} rawUrl - 待抓取的 URL（来自 QQ，不可信）。
 * @param {{
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   allowPrivateHosts?: boolean,
 *   maxRedirects?: number,
 *   fetchImpl?: typeof fetch,
 * }} [options] - 各项上限与注入的 fetch。
 * @returns {Promise<{ ok: boolean, title?: string, url?: string, status?: number, reason?: string }>}
 *   成功时 `url` 是**最终**地址（重定向之后），`status` 是最终响应的状态码。
 */
export async function fetchPageTitle(rawUrl, options = {}) {
  // 同上：参数写错/传 null 只该得到 `{ ok:false }`，不该让调用方收到一个 reject。
  const {
    timeoutMs = 8000,
    maxBytes = 524288,
    allowPrivateHosts = false,
    maxRedirects = 3,
    fetchImpl = fetch,
  } = options ?? {};
  const limitBytes = positiveInt(maxBytes, 524288);
  const hopLimit = nonNegativeInt(maxRedirects, 3);
  const limitMs = positiveInt(timeoutMs, 8000);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  let current = checkUrl(rawUrl, { allowPrivateHosts });
  if (!current.ok) return { ok: false, reason: current.reason };

  // 整个抓取（含所有重定向）共用一个计时器：否则 3 跳、每跳 8 秒，
  // 一次预览就能占住 24 秒。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    for (let hop = 0; hop <= hopLimit; hop += 1) {
      let response;
      try {
        response = await doFetch(current.url, { redirect: 'manual', signal: controller.signal });
      } catch (error) {
        return { ok: false, reason: isAbort(error) ? 'timeout' : 'network' };
      }
      if (!response) return { ok: false, reason: 'network' };
      const status = Number(response.status);
      if (!Number.isFinite(status) || status < 100 || status > 599) return { ok: false, reason: 'network' };

      if (status >= 300 && status < 400) {
        const location = headerValue(response.headers, 'location');
        if (typeof location !== 'string' || location.trim() === '') return { ok: false, reason: 'redirect', status };
        if (hop === hopLimit) return { ok: false, reason: 'redirects', status };
        let nextRaw;
        try {
          // location 可能是相对路径，也可能指向另一个站点；按当前 URL 解析。
          nextRaw = new URL(location.trim(), current.url).href;
        } catch {
          return { ok: false, reason: 'redirect-bad-url', status };
        }
        // 每一跳都重新校验：跳转目标同样来自那个不可信的链接，可以指向 127.0.0.1。
        const next = checkUrl(nextRaw, { allowPrivateHosts });
        if (!next.ok) return { ok: false, reason: `redirect-${next.reason}`, status };
        current = next;
        continue;
      }

      if (status < 200 || status >= 300) return { ok: false, reason: 'status', status };

      const contentType = headerValue(response.headers, 'content-type');
      const mime = mimeType(contentType);
      // 只收这两种：别的类型要么读不出标题，要么（图片/二进制）根本不该为标题去读。
      if (mime !== 'text/html' && mime !== 'text/plain') return { ok: false, reason: 'content-type', status };

      let bytes;
      try {
        bytes = await readCapped(response, limitBytes);
      } catch (error) {
        return { ok: false, reason: isAbort(error) ? 'timeout' : 'network', status };
      }
      const title = pageTitle(decodeBody(bytes, contentType));
      if (!title) return { ok: false, reason: 'no-title', status };
      return { ok: true, title, url: current.url, status };
    }
    // 循环正常走完只可能是 hopLimit 那一步已经 return；留一个兜底，别返回 undefined。
    return { ok: false, reason: 'redirects' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把成功抓取的标题渲染成正文里的一行（感知层的 `[链接: …]` 占位符）。
 *
 * 格式固定为 `[链接: 【标题】 — host url]`：标题是别人写的一行字，方括号 + 书名号
 * 让它一眼就能和正文区分开；host 取**最终** URL（重定向之后真正拿到标题的地方），
 * 而不是原始链接里的域名。没有标题（或没有 URL）时返回 undefined —— 调用方退回
 * 普通文本即可，别为了凑一行去编标题。
 *
 * @param {{ ok?: boolean, title?: string, url?: string } | undefined} result -
 *   {@link fetchPageTitle} 的返回值（手工构造的同形状对象也行）。
 * @returns {string | undefined} 例如 `[链接: 【示例】 — example.com https://example.com/]`。
 */
export function previewLine(result) {
  if (!result || result.ok !== true) return undefined;
  const title = typeof result.title === 'string' ? result.title.trim() : '';
  const url = typeof result.url === 'string' ? result.url.trim() : '';
  if (title === '' || url === '') return undefined;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // URL 是抓取侧给的，正常不会坏；真坏了就只渲染标题与原文，别丢整行。
    host = '';
  }
  return host === ''
    ? `[链接: 【${title}】 — ${url}]`
    : `[链接: 【${title}】 — ${host} ${url}]`;
}

// ---- 内部工具：卡片解析 ----

/**
 * 解析 json 卡片。字段布局在真实卡片里很松散，所以按「结构化层」逐个找：
 * `detail_1` / `detail_2`（小程序、分享）/ `news`（新闻）/ `meta` 自己，
 * 谁先有非空字符串就用谁。
 *
 * @param {string} raw - `data.data` 的 JSON 字符串。
 * @returns {{ title?: string, desc?: string, url?: string, site?: string } | undefined}
 */
function parseJsonCard(raw) {
  let root;
  try {
    root = JSON.parse(raw);
  } catch {
    return undefined; // 卡片 JSON 是别人拼的，坏了就退回 `[卡片消息]`，不要抛
  }
  if (!isPlainObject(root)) return undefined;
  const meta = isPlainObject(root.meta) ? root.meta : {};
  const layers = [meta.detail_1, meta.detail_2, meta.news, meta].filter(isPlainObject);

  const fromLayers = (...keys) => {
    for (const layer of layers) {
      for (const key of keys) {
        const value = layer[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
    }
    return undefined;
  };
  const fromRoot = (key) => {
    const value = root[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  // `prompt` 通常在根上（`[QQ小程序]…`），没有标题时拿它兜底已经够用；
  // 真有标题就用标题，别让「[QQ小程序]」这类前缀冒充标题。
  const title = capText(fromLayers('title') ?? fromLayers('prompt') ?? fromRoot('prompt') ?? fromRoot('title'), TITLE_MAX);
  const desc = capText(fromLayers('desc') ?? fromRoot('desc'), DESC_MAX);
  const url = capRawText(fromLayers('qqdocurl', 'jumpUrl', 'url') ?? fromRoot('jumpUrl') ?? fromRoot('url'), URL_MAX);

  let site = '';
  for (const layer of layers) {
    const nick = isPlainObject(layer.host) ? layer.host.nick : undefined;
    if (typeof nick === 'string' && nick.trim() !== '') {
      site = capText(nick, SITE_MAX);
      break;
    }
  }
  return buildCard({ title, desc, url, site });
}

/**
 * 解析 xml 卡片。刻意不用 XML 解析器：结构就 `<title>` / `<summary>` / `<url>`
 * 三个标签，而正则对畸形输入只会「找不到」，不会抛。
 *
 * @param {string} raw - `data.data` 的 XML 字符串。
 * @returns {{ title?: string, desc?: string, url?: string, site?: string } | undefined}
 */
function parseXmlCard(raw) {
  const title = capText(decodeMarkupText(readXmlTag(raw, 'title') ?? ''), TITLE_MAX);
  const desc = capText(decodeMarkupText(readXmlTag(raw, 'summary') ?? ''), DESC_MAX);
  let url = capRawText(decodeMarkupText(readXmlTag(raw, 'url') ?? ''), URL_MAX);
  if (url === '') {
    // 真实卡片常常没有 <url> 子标签，链接挂在根 <msg url="…"> 的属性上。
    const rootTag = /<msg\b[^>]*>/i.exec(raw);
    if (rootTag) url = capRawText(decodeMarkupText(attrValue(rootTag[0], 'url') ?? ''), URL_MAX);
  }
  let site = '';
  const sourceTag = /<source\b[^>]*>/i.exec(raw);
  if (sourceTag) site = capText(decodeMarkupText(attrValue(sourceTag[0], 'name') ?? ''), SITE_MAX);
  return buildCard({ title, desc, url, site });
}

/**
 * 拼卡片结果。只有「站点名」而没有标题/摘要/链接的卡片没有任何可渲染的信息，
 * 按「解析失败」处理 —— 否则调用方会拿到一个只能渲染出空括号的对象。
 *
 * @param {{ title: string, desc: string, url: string, site: string }} fields
 * @returns {{ title?: string, desc?: string, url?: string, site?: string } | undefined}
 */
function buildCard({ title, desc, url, site }) {
  const card = {};
  if (title !== '') card.title = title;
  if (desc !== '') card.desc = desc;
  if (url !== '') card.url = url;
  if (site !== '') card.site = site;
  return card.title || card.desc || card.url ? card : undefined;
}

/**
 * 取一个 XML 标签的内容。标签名是本模块写死的字面量（`title`/`summary`/`url`），
 * 不来自输入，所以拼进正则没有注入面。
 *
 * @param {string} raw - XML 文本。
 * @param {string} name - 标签名。
 * @returns {string | undefined} 标签内的原文（可能含 CDATA/实体，交给调用方解码）。
 */
function readXmlTag(raw, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i');
  const match = pattern.exec(raw);
  return match ? match[1] : undefined;
}

// ---- 内部工具：SSRF 判定 ----

/**
 * 判定一个主机名是否指向内网/保留地址。
 *
 * 除了 `checkUrl` 自己用，也导出给 `image.js`：出站图片的 URL 抓取要先解析 DNS，
 * 再把每个解析结果交给这里判一次（字面量判定拦不住 `127.0.0.1.nip.io` 这种）。
 * @param {string} hostname - URL 解析出来的 hostname（IPv6 带方括号），或一个裸 IP。
 * @returns {'localhost' | 'internal-host' | 'private-ip' | 'bad-url' | undefined}
 */
export function hostReason(hostname) {
  if (hostname.startsWith('[')) {
    const bytes = ipv6Bytes(hostname);
    if (!bytes) return 'bad-url';
    return ipv6Reason(bytes);
  }
  const bare = hostname.replace(/\.+$/, '');
  const v4 = parseIPv4(bare);
  if (v4) return ipv4Reason(v4);
  // WHATWG URL 已经把 `2130706433` / `0x7f.0.0.1` / `0177.0.0.1` 归一成点分十进制；
  // 这里再兜一层：万一某个实现漏了归一化，「看起来就是纯数字/0x 标签」的主机
  // 也按内网处理，绝不能让它因为 parseIPv4 不认就落进「域名」那一支被放行。
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(bare)) return 'private-ip';
  return hostNameReason(bare);
}

/**
 * 按域名判内网。公网域名至少有一个点；没有点的单标签主机只可能在内网有含义。
 * @param {string} host - 去掉结尾点的主机名。
 * @returns {'localhost' | 'internal-host' | 'bad-url' | undefined}
 */
function hostNameReason(host) {
  const name = host.toLowerCase();
  if (name === '') return 'bad-url';
  if (name === 'localhost' || name.endsWith('.localhost')) return 'localhost';
  // .local（mDNS）/ .internal / .localdomain 都是「只在内网有含义」的后缀；
  // 单标签主机（intranet、nas、wiki）同理。
  if (name === 'local' || name.endsWith('.local')) return 'internal-host';
  if (name === 'internal' || name.endsWith('.internal')) return 'internal-host';
  if (name === 'localdomain' || name.endsWith('.localdomain')) return 'internal-host';
  if (!name.includes('.')) return 'internal-host';
  return undefined;
}

/**
 * 把一个点分十进制 IPv4 解析成 4 个字节。
 * @param {string} host - 形如 `127.0.0.1`。
 * @returns {number[] | undefined}
 */
function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

/**
 * 私有/保留 IPv4 网段判定。
 * @param {number[]} bytes - 4 个字节。
 * @returns {'private-ip' | undefined}
 */
function ipv4Reason(bytes) {
  const [a, b, c] = bytes;
  if (a === 0) return 'private-ip'; // 0.0.0.0/8 「本网络」
  if (a === 10) return 'private-ip'; // 10/8
  if (a === 127) return 'private-ip'; // 127/8 回环
  if (a === 169 && b === 254) return 'private-ip'; // 169.254/16 链路本地（云元数据就在这）
  if (a === 172 && (b & 0xf0) === 16) return 'private-ip'; // 172.16/12
  if (a === 192 && b === 168) return 'private-ip'; // 192.168/16
  if (a === 100 && (b & 0xc0) === 64) return 'private-ip'; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return 'private-ip'; // 192.0.0/24
  if (a === 198 && (b & 0xfe) === 18) return 'private-ip'; // 198.18/15 基准测试
  if (a >= 224) return 'private-ip'; // 224/4 组播 + 240/4 保留
  return undefined;
}

/**
 * 把 IPv6 字面量解析成 16 个字节。
 *
 * 为什么自己写：Node 的 `URL` 只做序列化，不提供「这是哪个网段」；而 `::ffff:a.b.c.d`
 * 的方括号写法在序列化后可能变成 `::ffff:7f00:1`，必须自己把末尾 32 位抠出来。
 *
 * @param {string} hostname - 带方括号的 IPv6 字面量。
 * @returns {number[] | undefined}
 */
function ipv6Bytes(hostname) {
  let text = hostname.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return undefined;
  const gap = text.indexOf('::');
  // 最多一个 `::`（`:::` 这种会被下面的空段判掉）。
  if (gap !== -1 && text.indexOf('::', gap + 1) !== -1) return undefined;
  if (gap === -1) {
    const words = ipv6Words(text);
    if (!words || words.length !== 8) return undefined;
    return wordsToBytes(words);
  }
  const left = ipv6Words(text.slice(0, gap));
  const right = ipv6Words(text.slice(gap + 2));
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  // `::` 至少要压缩掉一组，否则地址不合法。
  if (missing < 1) return undefined;
  return wordsToBytes([...left, ...new Array(missing).fill(0), ...right]);
}

/**
 * 把一段 IPv6 用 `:` 分出来的组转成 16 位字（支持结尾的点分 IPv4）。
 * @param {string} segment - 不含 `::` 的一段。
 * @returns {number[] | undefined}
 */
function ipv6Words(segment) {
  if (segment === '') return [];
  const words = [];
  for (const part of segment.split(':')) {
    if (part === '') return undefined;
    if (part.includes('.')) {
      const v4 = parseIPv4(part);
      if (!v4) return undefined;
      words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    words.push(parseInt(part, 16));
  }
  return words;
}

/**
 * 16 位字数组 → 字节数组。
 * @param {number[]} words
 * @returns {number[]}
 */
function wordsToBytes(words) {
  const bytes = [];
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff);
  return bytes;
}

/**
 * IPv6 私有/保留地址判定（含内嵌 IPv4）。
 * @param {number[]} bytes - 16 个字节。
 * @returns {'private-ip' | undefined}
 */
function ipv6Reason(bytes) {
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  // ::（未指定）与 ::1（回环）
  if (zero(0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return 'private-ip';
  // ::ffff:a.b.c.d（IPv4-mapped）与 ::a.b.c.d（IPv4-compatible）：末尾 32 位就是一个
  // IPv4，按 IPv4 的规矩再判一次 —— 否则 `[::ffff:127.0.0.1]` 会从这条缝里溜过去。
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4Reason(bytes.slice(12)) ? 'private-ip' : undefined;
  }
  if (zero(0, 12)) return ipv4Reason(bytes.slice(12)) ? 'private-ip' : undefined;
  if ((bytes[0] & 0xfe) === 0xfc) return 'private-ip'; // fc00::/7 唯一本地地址
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'private-ip'; // fe80::/10 链路本地
  if (bytes[0] === 0xff) return 'private-ip'; // ff00::/8 组播
  return undefined;
}

// ---- 内部工具：抓取 ----

/**
 * 从响应里按上限读字节。**只按流读**，读够就取消 —— 绝不能为了一个标题把整页读完，
 * 更不能把没有上限的 body 先 `arrayBuffer()` 下来（那正是「无界缓冲」）。
 *
 * @param {{ body?: unknown }} response - fetch 的响应（或同形状的假对象）。
 * @param {number} limit - 最多读多少字节。
 * @returns {Promise<Uint8Array>}
 */
async function readCapped(response, limit) {
  const body = response?.body;
  if (!body) return new Uint8Array(0);
  const reader = typeof body.getReader === 'function' ? body.getReader() : undefined;
  if (!reader) {
    // 注入的假响应只给字符串/字节：照样截断，别把无界内容整块交出去。
    const value = toBytes(body);
    return value ? value.subarray(0, limit) : new Uint8Array(0);
  }
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      if (!chunk || chunk.byteLength === 0) continue;
      const remain = limit - total;
      // 一个 chunk 可能就比上限大：切片而不是整块收下。
      chunks.push(chunk.byteLength > remain ? chunk.subarray(0, remain) : chunk);
      total += Math.min(chunk.byteLength, remain);
    }
  } finally {
    // 读够就取消：cancel 失败（已结束/已取消）不属于错误，吞掉。
    try { await reader.cancel(); } catch { /* 忽略 */ }
    try { reader.releaseLock?.(); } catch { /* 忽略 */ }
  }
  return concatBytes(chunks, total);
}

/**
 * 任意值 → 字节。只认字符串、Uint8Array、ArrayBuffer（真 fetch 的 chunk 是第一种）。
 * @param {unknown} value
 * @returns {Uint8Array | undefined}
 */
function toBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

/**
 * 拼字节数组。
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 按 content-type 里的 charset 解码。不猜 GBK 之类：解错了是乱码，猜错了是另一种乱码，
 * 而乱码标题作为数据渲染没有安全后果 —— 所以只在明确写 latin-1 时换一种解。
 * @param {Uint8Array} bytes
 * @param {unknown} contentType
 * @returns {string}
 */
function decodeBody(bytes, contentType) {
  const match = /charset\s*=\s*"?([^"';\s]+)/i.exec(String(contentType ?? ''));
  const charset = match ? match[1].toLowerCase() : '';
  const latin = charset === 'latin1' || charset === 'iso-8859-1' || charset === 'windows-1252';
  try {
    return new TextDecoder(latin ? 'latin1' : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * 取 media type（`text/html; charset=utf-8` → `text/html`）。
 * @param {unknown} contentType
 * @returns {string}
 */
function mimeType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * 取响应头。真实 `Headers` 有 `get`，注入的假对象可能只是普通对象。
 * @param {unknown} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * 正数兜底：非数/0/负数都退回默认值（上限参数写错时宁可保守，不要变成「不限」）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/**
 * 非负整数兜底（`maxRedirects: 0` 是合法值：一跳都不跟）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

/**
 * 这个异常是不是 abort 造成的。
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

// ---- 内部工具：文本 ----

/**
 * 取标签属性值。支持双引号、单引号、无引号三种写法，属性顺序无关。
 * @param {string} tag - 一个完整的标签文本。
 * @param {string} name - 属性名（本模块写死的字面量）。
 * @returns {string | undefined}
 */
function attrValue(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * 解码一段标记文本：CDATA 段按字面保留（XML 规定里面不解码实体），其余部分解实体。
 *
 * 为什么分开：QQ 的 xml 卡片常把标题包在 `<![CDATA[…]]>` 里，里面的 `&` 是字面量；
 * 若先拆掉 CDATA 再统一解码，`&amp;` 会被错误地还原成 `&`。
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeMarkupText(raw) {
  const text = String(raw ?? '');
  let out = '';
  let last = 0;
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    out += decodeEntities(text.slice(last, match.index));
    out += match[1];
    last = pattern.lastIndex;
  }
  out += decodeEntities(text.slice(last));
  return out;
}

/**
 * 只解最基础的实体：五个命名实体 + 十进制/十六进制数字实体，外加 `&nbsp;`。
 * 未知实体原样保留 —— 解不出来的东西原样显示，比吞掉更诚实。
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // 0 与代理区（D800–DFFF）会产出坏字符/孤立代理项，直接丢掉。
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code >= 0xd800 && code <= 0xdfff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    switch (body.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return whole;
    }
  });
}

/**
 * 折叠空白 + 按上限截断（按 Unicode 码点截，别把 emoji 的代理对切成半个）。
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function capText(value, limit) {
  const folded = String(value ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(folded).slice(0, limit).join('');
}

/**
 * 只 trim + 截断，不改内部字符（URL 用：折叠空白会把合法字符弄坏）。
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function capRawText(value, limit) {
  return Array.from(String(value ?? '').trim()).slice(0, limit).join('');
}

/**
 * 非数组的普通对象。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
