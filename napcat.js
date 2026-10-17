/**
 * NapCat（OneBot v11）那一侧的配置：**探测**它现在长什么样、**幂等**地把它改成我们要的样子。
 *
 * 为什么值得单独一个模块：这是「机器人为什么不回复」里最常见、也最难自己看出来的一环 ——
 * 插件这边配置齐全、WS 也连上了，但 NapCat 里根本没有一条启用的 WebSocket 服务器，
 * 或者端口对不上、token 对不上。用户看到的现象只是「它不说话」，而线索全在另一个
 * 软件的 JSON 文件里。所以这里做三件事：
 *
 *   1. `inspectNapcat`：给一个 NapCat 的 config 目录，读它的 onebot11 配置，回答
 *      「现在这条链路通不通、不通是哪里不通」——**只看，不改**；
 *   2. `repairNapcat`：把缺的那一条写进去（先备份原文件，且**已经对了就一个字节都不动**）；
 *   3. 启动那半边（发布版安装流程踩出来的）：`findNapcatDir` 除了「有账号配置」这种强判据，
 *      还认「目录里有 NapCat 自带的启动件」这种弱判据（刚解压、还没登录过也算）；
 *      `withAutoLoginAccount` 让它启动时自己快速登录、不用每次扫码；`startPlan` 描述
 *      「Windows 上要以管理员身份怎么起」——**不提权时 QQ 会在注入后崩在 QQNT.dll**，
 *      这是实测结论，理由写在该函数上。
 *   4. 不让它弹那个黑框框（本地实测出来的另一半）：`hiddenWrapperVbs` + `hiddenStartPlan`
 *      用一个 GUI 宿主的包装脚本（wscript + VBS）把控制台**从创建那一刻**就隐藏掉；
 *      `scheduledTaskXml` / `scheduledTaskInstallPlan` 再把它变成「登录时以管理员身份、
 *      无窗口、以后不再问 UAC」的计划任务。`withNapcatLogging` 负责把日志改去文件 ——
 *      窗口看不见之后，日志是唯一的现场。
 *
 * 三条纪律：
 *
 *   - **它是叶子模块**：不 import `index.js`，也不碰任何闭包状态。插件启动自检与命令行
 *     一键脚本（`scripts/napcat-setup.mjs`）用的是同一批函数 —— 两边各写一份的话，
 *     「脚本配好了但插件说没配好」这种事迟早发生。
 *   - **写之前先备份、且幂等**：NapCat 的配置是用户自己也在用的东西，可能还有
 *     httpServers / websocketClients / 别人加的条目。我们只动 `websocketServers`
 *     里那一条，其余原样保留；改之前把原文件复制成 `<名>.bak-<时间戳>`。
 *   - **不猜**：认不出 QQ 号、读不出 JSON、目录不存在，一律返回带原因的结果，
 *     由调用方决定记 warn 还是让用户去跑脚本。
 *
 * NapCat 那边 `websocketServers` 条目的字段（照它自己的 schema，见 NapCat 产物里的
 * `websocket-server`）：`name / enable / host / port / messagePostFormat /
 * reportSelfMessage / token / enableForcePushEvent / debug / heartInterval`。
 * 其中 `reportSelfMessage: false` 是**必须**的：机器人自己发的消息不该作为事件回灌，
 * 否则它会把「自己刚说的话」当成别人说的，接自己的话（docs/windows.md 里有这一条）。
 *
 * @module @qqbot/dsh-plugin-qq/napcat
 */
import { copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTextOrUndefined, writeJsonAtomic } from './filestore.js';

/** 写进 NapCat 配置的那一条服务器名：一眼能看出是谁加的。 */
export const SERVER_NAME = 'dsh-qq-bridge';

/** 备份文件名里用的时间戳：`2026-01-31T0412` 这种能排序、又不会有冒号（Windows 非法）的形状。 */
function backupStamp(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, '');
}

/**
 * 从 OneBot 的 endpoint 里取出主机与端口。
 *
 * 只认 `ws://` / `wss://`。取不到时返回 undefined —— 调用方那时应当说一句「你配的
 * endpoint 我解析不了」，而不是拿一个默认端口去改别人的 NapCat 配置。
 *
 * @param endpoint - 例如 `ws://127.0.0.1:3001`。
 * @returns `{ host, port }`；解析不出来时 undefined。
 */
export function endpointTarget(endpoint) {
  const text = String(endpoint ?? '').trim();
  // 主机部分要**排除冒号**（`[^/?#:]+`），否则贪婪匹配会把 `127.0.0.1:3001` 整个吃成主机名，
  // 端口永远解析不出来 —— 那样自检会以为「你端口都没写」而拒绝干活。
  // 方括号里的 IPv6 字面量是唯一合法的「主机里有冒号」的写法，单独放一个分支。
  const match = /^wss?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?/i.exec(text);
  if (match === null) return undefined;
  const host = match[1];
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (host.length === 0) return undefined;
  if (port !== undefined && (!Number.isSafeInteger(port) || port <= 0 || port > 65535)) return undefined;
  return { host, port };
}

/**
 * 从 NapCat config 目录里的文件名认出「有哪些账号、各自的 OneBot 网络配置在哪」。
 *
 * NapCat 在 Windows 上按 `onebot11_<QQ号>.json` 落盘（容器版是同名文件）；它同时还会写
 * `napcat_<QQ>.json`（框架配置）与 `napcat_protocol_<QQ>.json`（连 QQ 的协议端）。
 * 只认 `onebot11_*`：**网络配置在那个文件里**，另外两个里没有 `websocketServers`，
 * 改它们等于白改（而且会让人以为「明明改了却不生效」）。
 *
 * @param names - 目录下的文件名列表（由调用方 `readdir` 得到，便于测试）。
 * @returns `[{ qq, file }]`，按 QQ 号排序；认不出时为空数组。
 */
export function accountFiles(names) {
  const out = [];
  for (const name of names ?? []) {
    const match = /^onebot11_(\d+)\.json$/i.exec(String(name));
    if (match === null) continue;
    out.push({ qq: match[1], file: String(name) });
  }
  return out.sort((left, right) => left.qq.localeCompare(right.qq));
}

/**
 * 我们期望 NapCat 里存在的那一条 WebSocket 服务器。
 *
 * 字段取值都照 NapCat 自己的 schema 默认值，只把 `enable` 打开、`reportSelfMessage`
 * 关掉、填上端口与 token。`messagePostFormat: 'array'` 与该 schema 默认一致，
 * 也是插件解析事件的前提（string 格式下 `message` 是一整条 CQ 码字符串）。
 *
 * @param options.name - 条目名（默认 {@link SERVER_NAME}）。
 * @param options.port - 监听端口（必须与插件的 endpoint 一致）。
 * @param options.token - access_token；NapCat 用空串表示不校验。
 * @param options.host - 监听地址；默认 `127.0.0.1`（只给本机连，别把 QQ 机器人暴露到局域网）。
 * @returns 可以直接塞进 `network.websocketServers` 的对象。
 */
export function desiredServer({ name = SERVER_NAME, port, token = '', host = '127.0.0.1' } = {}) {
  return {
    name,
    enable: true,
    host,
    port,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token: String(token ?? ''),
    enableForcePushEvent: true,
    debug: false,
    heartInterval: 30000,
  };
}

/**
 * 看一个 onebot11 配置对象里，有没有一条**真的能用**的 WebSocket 服务器。
 *
 * 判定刻意严到「只差一个 reportSelfMessage 也算能用」：那个字段错了会表现得像 bug
 * （接自己的话），但它不是「连不上」，所以只作为 note 提一句，不算 mismatch。
 *
 * @param config - onebot11_<qq>.json 解析出来的对象。
 * @param options.port - 插件 endpoint 的端口。
 * @param options.token - 插件配置的 accessToken。
 * @returns `{ ok, reason, matched, notes }`：
 *   `ok` 为 false 时 `reason` 是一句能直接给用户看的中文；
 *   `matched` 是命中的那一条（可能是端口对但没启用）。
 */
export function inspectOnebotConfig(config, { port, token = '' } = {}) {
  const notes = [];
  if (!Number.isSafeInteger(Number(port)) || Number(port) <= 0) {
    return { ok: false, reason: `endpoint 里解析不出端口（拿到的是 ${String(port)}）`, notes };
  }
  const servers = config?.network?.websocketServers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return { ok: false, reason: `没有配置任何 WebSocket 服务器（缺一条监听 ${port} 的）`, notes };
  }
  const samePort = servers.filter((entry) => Number(entry?.port) === Number(port));
  if (samePort.length === 0) {
    const ports = servers.map((entry) => `${entry?.port ?? '?'}`).join(' / ');
    return { ok: false, reason: `已有 WebSocket 服务器端口是 ${ports}，没有一条监听 ${port}`, notes };
  }
  const enabled = samePort.filter((entry) => entry?.enable === true);
  if (enabled.length === 0) {
    return { ok: false, reason: `端口 ${port} 的那一条没有启用（enable: false）`, matched: samePort[0], notes };
  }
  const matched = enabled[0];
  // token 必须逐字相同：NapCat 那边设了 token，插件这边没写（或写反），
  // 表现是 WS 连上又立刻被拒 —— 日志里只有一句「closed」，很容易被当成网络问题。
  const expected = String(token ?? '');
  if (String(matched.token ?? '') !== expected) {
    return {
      ok: false,
      reason: expected.length === 0
        ? `端口 ${port} 的那一条设了 token，而插件这边 accessToken 是空的`
        : `端口 ${port} 的那一条 token 与插件的 accessToken 不一致`,
      matched,
      notes,
    };
  }
  if (matched.reportSelfMessage !== false) {
    notes.push('reportSelfMessage 不是 false：机器人会收到自己发的消息，可能接自己的话');
  }
  if (typeof matched.host === 'string' && matched.host !== '127.0.0.1' && matched.host !== 'localhost') {
    notes.push(`监听地址是 ${matched.host}（本机插件连 127.0.0.1 仍然通，但这条链路同时也暴露在网络上）`);
  }
  return { ok: true, matched, notes };
}

/**
 * 我们**拥有**的那几个字段：改写已有条目时只覆盖它们。
 *
 * 为什么要有这张名单：`desiredServer()` 给出的是一份完整、合法的条目（追加的时候要整份
 * 写进去），但改写时不能把整份盖上去 —— NapCat 那边还有 `debug`、`heartInterval` 这类
 * 用户自己调过的字段，盖掉就等于「插件顺手改了你别的设置」。
 */
const OWNED_FIELDS = ['name', 'enable', 'host', 'port', 'messagePostFormat', 'reportSelfMessage', 'token', 'enableForcePushEvent'];

/**
 * 把期望的那一条**幂等**地写进配置对象。
 *
 * 三条规矩：
 *   - 已经有一条同名/同端口的条目 → **原地改**（只动 {@link OWNED_FIELDS} 里那几个，
 *     用户调过的 `debug` / `heartInterval` 留着），而不是再追加一条出来（两条同端口的
 *     服务器在 NapCat 里会互相抢端口，症状是「刚才还能用，改完就不能用了」）；
 *   - 别的地方一个字段都不动：`httpServers` / `websocketClients` / `timeout` 里可能有
 *     用户自己的东西；
 *   - 返回 `changed`：调用方靠它决定「要不要写盘、要不要说一句『改好了』」——
 *     已经对了的时候连备份都不该产生。
 *
 * @param config - 原配置对象（不会被修改）。
 * @param desired - {@link desiredServer} 的结果。
 * @returns `{ changed, config }`：`config` 是**新对象**（没变时是同一个引用）。
 */
export function withWebsocketServer(config, desired) {
  const base = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const network = base.network !== null && typeof base.network === 'object' && !Array.isArray(base.network)
    ? base.network
    : {};
  const servers = Array.isArray(network.websocketServers) ? [...network.websocketServers] : [];
  const index = servers.findIndex((entry) => entry?.name === desired.name || Number(entry?.port) === Number(desired.port));
  let merged = desired;
  if (index !== -1) {
    merged = { ...servers[index] };
    for (const field of OWNED_FIELDS) merged[field] = desired[field];
    // 字段顺序跟原条目走（diff 起来干净），但我们新加的字段排后面 —— 对象键序不影响
    // NapCat 解析，这里只是让「改了哪几个字段」在 git diff 里一眼可见。
  }
  const same = index !== -1 && JSON.stringify(servers[index]) === JSON.stringify(merged);
  if (same) return { changed: false, config };
  if (index === -1) servers.push(merged);
  else servers[index] = merged;
  const next = { ...base, network: { ...network, websocketServers: servers } };
  return { changed: true, config: next };
}

/**
 * 把「启动时登录哪个号」写进 NapCat 的 WebUI 配置（`config/webui.json` 的 `autoLoginAccount`）。
 *
 * 为什么值得写：不写的话每次启动 NapCat 都得在控制台看二维码、掏手机扫一次；写进去之后
 * NapCat 启动时会自己**快速登录**这个号（它读的就是这一项）。前提是本机已经为这个号留下
 * 过登录记录 —— 没有记录时 NapCat 会退回二维码，那不是失败，所以我们只写配置，
 * 不假装「以后一定免扫码」。
 *
 * 与 {@link withWebsocketServer} 同一套路：只碰我们拥有的那一个字段，别的原样保留；
 * 内容没变就返回 `changed: false`，调用方据此决定「要不要写盘、要不要留备份」。
 *
 * @param config - `webui.json` 解析出来的对象。
 * @param qq - 机器人自己的 QQ 号；留空表示什么都不做。
 * @returns `{ changed, config }`：`config` 是**新对象**（没变时是同一个引用）。
 */
export function withAutoLoginAccount(config, qq) {
  const wanted = String(qq ?? '').trim();
  const base = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  if (wanted.length === 0) return { changed: false, config };
  if (String(base.autoLoginAccount ?? '') === wanted) return { changed: false, config };
  return { changed: true, config: { ...base, autoLoginAccount: wanted } };
}

/**
 * 把 NapCat 的日志**改去文件**（`config/napcat.json` 的 `consoleLog` / `fileLog`）。
 *
 * 为什么这件事跟「隐藏窗口」绑在一起：窗口一藏就没有控制台可看了，而 NapCat 默认是
 * `consoleLog: true / fileLog: false` —— 出问题时用户手上会**一份现场都没有**。
 * 打开文件日志之后日志落在 `<NapCat>/logs/<时间戳>.log`（NapCat 自己按 5MB × 5 个轮转）。
 *
 * 只动这两个字段：同一个文件里还有 `fileLogLevel` / `packetBackend` / `bypass` 这些
 * 用户自己调过的东西，一律原样保留；内容没变就返回 `changed: false`。
 *
 * @param config - `config/napcat.json` 解析出来的对象。
 * @param options.consoleLog - 是否要控制台日志（隐藏启动时为 false）。
 * @param options.fileLog - 是否要文件日志（隐藏启动时为 true）。
 * @returns `{ changed, config }`：`config` 是**新对象**（没变时是同一个引用）。
 */
export function withNapcatLogging(config, { consoleLog = false, fileLog = true } = {}) {
  const base = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  if (base.consoleLog === consoleLog && base.fileLog === fileLog) return { changed: false, config };
  return { changed: true, config: { ...base, consoleLog, fileLog } };
}

/**
 * 从 `config/webui.json` 里算出「WebUI 在哪个地址、令牌是什么」。
 *
 * 隐藏启动之后，WebUI 是用户唯一还能看见的东西：**看日志、扫码登录、改配置**都在那里
 * （NapCat 的 WebUI 自带登录页与二维码，所以「窗口藏起来就没法扫码」并不成立）。
 * 而令牌是 NapCat 启动时随机生成、原本打在控制台上的 —— 控制台一藏，它就只能从这里读。
 *
 * 监听地址是 `0.0.0.0` / `::`（NapCat 的默认值，表示所有网卡）时，本机浏览器该访问
 * `127.0.0.1`；IPv6 字面量要加方括号才是合法 URL。
 *
 * @param config - `webui.json` 解析出来的对象。
 * @returns `{ url, host, port, token }`；端口读不出来时 undefined（那时不该打印一个假地址）。
 */
export function webuiTarget(config) {
  const base = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const host = String(base.host ?? '').trim();
  const port = Number(base.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined;
  const display = host.length === 0 || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${display.includes(':') ? `[${display}]` : display}:${port}`,
    host,
    port,
    token: String(base.token ?? ''),
  };
}

/**
 * 读一个 NapCat config 目录，回答「这条链路现在通不通」。
 *
 * 只看不改，所以它适合在每次插件启动时跑一遍：配置错了当场就有一条清楚的 warn，
 * 而不是等用户发现「它不说话」再回来翻文档。
 *
 * @param options.dir - NapCat 的 `config` 目录（不是 NapCat 根目录）。
 * @param options.endpoint - 插件的 OneBot 地址。
 * @param options.token - 插件的 accessToken。
 * @param options.qq - 只关心这个账号；留空表示目录里唯一的那个（多个时取第一个并记一句）。
 * @param options.readdirImpl - 列目录的实现（测试注入）。
 * @returns `{ found, account, file, config, verdict }` —— `verdict` 是
 *   {@link inspectOnebotConfig} 的结果；认不出账号时 `found: false` 且 `reason` 说明原因，
 *   其中「一份刚解压、还没登录过的 NapCat」会额外带 `noAccount: true`。
 */
export async function inspectNapcat({ dir, endpoint, token = '', qq = '', readdirImpl = readdir } = {}) {
  const target = endpointTarget(endpoint);
  if (target === undefined || target.port === undefined) {
    return { found: false, reason: `endpoint "${endpoint}" 里解析不出 ws://主机:端口` };
  }
  if (dir === undefined || dir.length === 0) return { found: false, reason: '没有配置 napcatDir' };
  if (!existsSync(dir)) return { found: false, reason: `目录不存在：${dir}` };
  let names;
  try {
    names = await readdirImpl(dir);
  } catch (error) {
    return { found: false, reason: `读不了目录 ${dir}：${error?.message ?? error}` };
  }
  const accounts = accountFiles(names);
  if (accounts.length === 0) {
    // `noAccount` 是一个**结构化的信号**，不是又一句要人去匹配的文案：调用方靠它区分
    // 「这份 NapCat 刚解压、还没登录过」（发布版安装流程里的正常中间态，该记 info 并告诉
    // 用户下一步）与「目录配错了 / 读不了」（那才是 warn）。
    return { found: false, noAccount: true, reason: `${dir} 里没有 onebot11_<QQ号>.json（NapCat 还没登录过账号？）` };
  }
  const wanted = String(qq ?? '').trim();
  const account = wanted.length > 0
    ? accounts.find((item) => item.qq === wanted)
    : accounts[0];
  if (account === undefined) {
    const known = accounts.map((item) => item.qq).join(' / ');
    return { found: false, reason: `这个目录里没有 QQ ${wanted} 的配置（有：${known}）` };
  }
  const file = join(dir, account.file);
  const text = await readTextOrUndefined(file);
  if (text === undefined) return { found: false, account, file, reason: `读不到 ${file}` };
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    // 半截 JSON（NapCat 正在写、或者用户手工编辑坏了）不能算「配置没问题」，
    // 更不能去覆盖它 —— 那会把用户别的设置一起抹掉。
    return { found: true, account, file, reason: `${account.file} 不是合法 JSON：${error?.message ?? error}` };
  }
  return {
    found: true,
    account,
    file,
    config,
    extra: accounts.length > 1 && wanted.length === 0 ? `目录里有多个账号（${accounts.map((item) => item.qq).join(' / ')}），只看第一个` : undefined,
    verdict: inspectOnebotConfig(config, { port: target.port, token }),
  };
}

/**
 * 把 {@link inspectNapcat} 的结论落成动作：需要就改，改之前备份。
 *
 * **只有在 `autoConfig` 为真时才会写盘。** 默认关着，因为这是一次跨软件的写操作：
 * 用户的 NapCat 里可能还有别的东西，插件的默认行为不该是「悄悄改别人的配置」。
 * 一键脚本（`scripts/napcat-setup.mjs`）传入 `autoConfig: true`，插件启动自检则按配置项走。
 *
 * @param options.dir - NapCat 的 `config` 目录。
 * @param options.endpoint - 插件的 OneBot 地址。
 * @param options.token - 插件的 accessToken。
 * @param options.qq - 只处理这个账号；留空表示目录里的第一个。
 * @param options.autoConfig - 是否允许写盘。
 * @param options.name - 条目名（默认 {@link SERVER_NAME}）。
 * @param options.host - 监听地址。
 * @param options.now - 备份时间戳的注入点（测试用）。
 * @param options.readdirImpl - 列目录的实现（测试注入）。
 * @returns `{ action, reason, file, backup, verdict }`：
 *   `action` 是 `'ok'`（本来就对）/ `'repaired'`（改了）/ `'needs-repair'`（要改但不允许）/
 *   `'unknown'`（查不出来，`reason` 说明为什么）；`noAccount: true` 是 `'unknown'` 里的一种，
 *   专指「这份 NapCat 还没登录过账号」（调用方该记 info 并告诉用户下一步，而不是 warn）。
 */
export async function repairNapcat({
  dir,
  endpoint,
  token = '',
  qq = '',
  autoConfig = false,
  name = SERVER_NAME,
  host = '127.0.0.1',
  now = Date.now(),
  readdirImpl = readdir,
} = {}) {
  const found = await inspectNapcat({ dir, endpoint, token, qq, readdirImpl });
  if (found.found !== true) {
    return { action: 'unknown', reason: found.reason, verdict: found.verdict, noAccount: found.noAccount === true };
  }
  if (found.config === undefined) return { action: 'unknown', reason: found.reason, file: found.file };
  if (found.verdict.ok) return { action: 'ok', file: found.file, verdict: found.verdict };
  const target = endpointTarget(endpoint);
  const desired = desiredServer({ name, port: target.port, token, host });
  const patched = withWebsocketServer(found.config, desired);
  if (!patched.changed) return { action: 'ok', file: found.file, verdict: found.verdict };
  if (!autoConfig) {
    return { action: 'needs-repair', reason: found.verdict.reason, file: found.file, verdict: found.verdict };
  }
  // 备份与写盘：备份失败就**不写**（宁可维持现状，也不能把没有备份的原文件覆盖掉）。
  const backup = `${found.file}.bak-${backupStamp(now)}`;
  await copyFile(found.file, backup);
  await writeJsonAtomic(found.file, patched.config);
  return { action: 'repaired', reason: found.verdict.reason, file: found.file, backup, verdict: found.verdict, config: patched.config };
}

/**
 * 「像一份 NapCat.Shell 解压产物」的判据：目录里有它自带的启动件。
 *
 * 这只是一条**弱判据**（相对「config 里有账号配置」那条强判据而言），但发布版安装流程
 * 离不开它：`config/onebot11_<QQ号>.json` 是 NapCat **登录之后**才生成的，而用户通常是
 * 「解压 NapCat.Shell.zip → 直接跑一键脚本」—— 那一刻 config 目录可能压根不存在。
 * 只认强判据的话，脚本会回一句「没找到 NapCat 安装目录」，`--qq` 那条「先把骨架配置
 * 写好、登录后就能用」的路永远走不到（发布版实测踩过：仓库根下明明躺着一份 NapCat.Shell）。
 *
 * @param names - 目录下的文件名列表（由调用方 `readdir` 得到，便于测试）。
 * @returns 像不像一份 NapCat 安装产物。
 */
export function looksLikeNapcatShell(names) {
  return (names ?? []).some((name) => SHELL_MARKERS.some((pattern) => pattern.test(String(name))));
}

/** NapCat 自带的启动件：Windows 的 `launcher*.bat` / `launcher-elevate.ps1`，以及各平台都有的那几个。 */
const SHELL_MARKERS = [
  /^launcher[^\\/]*\.(bat|ps1)$/i,
  /^napcat\.mjs$/i,
  /^loadNapCat\.js$/i,
  /^NapCatWinBootMain\.exe$/i,
];

/**
 * 找一个「像 NapCat 安装目录」的地方。两种证据，强判据优先：
 *
 *   1. **强**：`config/onebot11_<QQ号>.json` 存在 —— 这是登录过的 NapCat，能直接读/改；
 *   2. **弱**：目录里有 NapCat 自带的启动件（{@link looksLikeNapcatShell}）—— 刚解压、
 *      还没登录过的那种，脚本正需要它来先写一份骨架配置。
 *
 * 只用于**自动探测**（插件启动时的自检、脚本不给参数时的兜底）：用户明确指了
 * `napcatDir` 就以那个为准。候选顺序按「越具体越优先」，并且不递归扫盘 ——
 * 一个插件不该为了找配置把用户的硬盘遍历一遍。
 *
 * @param candidates - 候选目录（绝对路径）。
 * @param options.readdirImpl - 列目录的实现（测试注入）。
 * @returns 第一个命中的目录（返回的是 NapCat 根目录，不是 config），找不到时 undefined。
 */
export async function findNapcatDir(candidates, { readdirImpl = readdir } = {}) {
  for (const candidate of candidates ?? []) {
    const dir = String(candidate ?? '').trim();
    if (dir.length === 0) continue;
    const root = resolve(dir);
    const configDir = join(root, 'config');
    if (existsSync(configDir)) {
      let names;
      try {
        names = await readdirImpl(configDir);
      } catch {
        names = undefined;
      }
      if (names !== undefined && accountFiles(names).length > 0) return root;
    }
    // 弱判据要另读一次根目录：`config` 不存在时上面那条路直接跳过了。
    let rootNames;
    try {
      rootNames = await readdirImpl(root);
    } catch {
      continue;
    }
    if (looksLikeNapcatShell(rootNames)) return root;
  }
  return undefined;
}

/** {@link startPlan} 支持的控制台窗口显示方式。 */
export const START_WINDOW_STYLES = ['normal', 'min', 'hidden'];

/** 计划任务名：固定、可预测，用户自己 `schtasks /query /tn <名字>` 就能找到它。 */
export const TASK_NAME = 'dsh-qq-bridge-napcat';

/** 隐藏启动的包装脚本名（VBScript）：放在 NapCat 目录里，跟着它一起删。 */
export const HIDDEN_WRAPPER_NAME = 'dsh-qq-bridge-hidden.vbs';

/** 计划任务 XML 的名字：注册时喂给 `schtasks /xml`，留着也方便用户自己看/改。 */
export const TASK_XML_NAME = 'dsh-qq-bridge-task.xml';

/** 写进计划任务「描述」栏的那句话（任务计划程序界面里能看见它）。 */
const TASK_DESCRIPTION = '以管理员身份、无窗口启动 NapCat（QQ 机器人），由 dsh-qq-bridge 安装。';

/** PowerShell 单引号字符串：里面的 `'` 要写成两个，否则路径里带引号就会被拆开。 */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * 把一段 PowerShell 包成「走 Base64 的提权调用」。
 *
 * 为什么统一走 `-EncodedCommand`：路径里可能有空格、中文、单引号，一层层引号转义最容易
 * 栽在这些地方；NapCat 自己的 `launcher-elevate.ps1` 也是这么传的，跟着它走。
 * 三个 plan（`startPlan` / `hiddenStartPlan` / `scheduledTaskInstallPlan`）共用它，
 * 免得哪天只有一处漏了编码。
 */
function elevatedCommand(script) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/**
 * 算出「怎么把 NapCat 启动起来」：**纯函数**，只描述要 spawn 什么、不真的 spawn（便于测试）。
 *
 * 两个决定写在这里，都有实测依据：
 *
 *   - **提权**（`-Verb RunAs`）：Windows 上必须以管理员身份启动。实测（QQ 9.9.35-52892 +
 *     NapCat 4.18.38）：以普通用户身份启动时注入其实是成功的（崩溃转储的模块列表里能看到
 *     `NapCatWinBootHook.dll` 已加载），但 QQ 随后在 `QQNT.dll` 里撞 `0x80000003`
 *     （STATUS_BREAKPOINT）当场死掉，控制台只剩一句 `Process exited.`；提权启动则正常。
 *     这与官方文档也一致 —— 它让双击的 `launcher.bat` 本身就是「会自己提权」的那个，
 *     而 `launcher-user.bat` 是刻意不提权的变体。
 *   - **命令走 Base64**（`-EncodedCommand`）：路径里可能有空格、中文、单引号，一层层引号
 *     转义最容易栽在这些地方；NapCat 自己的 `launcher-elevate.ps1` 也是这么传的，跟着它走。
 *
 * 窗口样式只影响那个控制台：**首次登录要扫码，得能看见窗口**，所以第一次请用
 * `normal` 或 `min`；`hidden` 交给 {@link hiddenStartPlan}（另一个机制：这个函数自己
 * 起的那个控制台还能靠 `-WindowStyle` 藏，但只有 GUI 宿主的包装脚本才藏得干净）。
 *
 * @param options.platform - 目标平台（默认当前进程的）。
 * @param options.launcher - 启动器 `.bat` 的绝对路径（有 `launcher.bat` 就优先用它）。
 * @param options.qq - 机器人 QQ 号；给了就传 `-q <号>`，让 NapCat 走快速登录。
 * @param options.windowMode - `normal` / `min` / `hidden`，默认 `min`；认不出的取值按默认处理。
 * @param options.wrapper - `hidden` 时用的包装脚本（见 {@link hiddenWrapperVbs}）；其余样式不用。
 * @returns 可以照做时 `{ command, args, describe }`；平台不对 / 缺启动器 / `hidden` 缺包装脚本时 `{ unsupported }`。
 */
export function startPlan({ platform = process.platform, launcher, qq = '', windowMode = 'min', wrapper = '' } = {}) {
  if (platform !== 'win32') {
    return { unsupported: `只在 Windows 上用启动器直接拉起 NapCat（当前平台是 ${platform}）` };
  }
  const mode = START_WINDOW_STYLES.includes(String(windowMode)) ? String(windowMode) : 'min';
  // 隐藏那条路是另一个机制（wscript + VBS），在这里就分流，别把两套东西揉进一个分支里。
  if (mode === 'hidden') return hiddenStartPlan({ platform, wrapper, qq });
  const file = String(launcher ?? '').trim();
  if (file.length === 0) {
    return { unsupported: '找不到启动器（NapCat 目录里既没有 launcher.bat 也没有 launcher-user.bat）' };
  }
  // 只剩「看得见」的两种（hidden 已经在上面走了）：这个映射不必再有第三项。
  const style = { normal: { name: 'Normal', label: '正常' }, min: { name: 'Minimized', label: '最小化' } }[mode];
  const wanted = String(qq ?? '').trim();
  const launcherArgs = wanted.length > 0 ? ['-q', wanted] : [];
  const argumentList = launcherArgs.length > 0 ? `@(${launcherArgs.map((item) => psQuote(item)).join(', ')})` : '@()';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process -FilePath ${psQuote(file)} -ArgumentList ${argumentList} -Verb RunAs -WindowStyle ${style.name}`,
  ].join('; ');
  return {
    ...elevatedCommand(script),
    // 给用户看的一句话：脚本和 `--dry-run` 共用它，所以说清「干什么、什么窗口、登录谁」。
    describe: `以管理员身份启动 ${file}（窗口：${style.label}${wanted.length > 0 ? `；快速登录 ${wanted}` : ''}）`,
  };
}

/** VBScript 字符串字面量：里面每个 `"` 都要写两遍（VBS 的转义规则）。 */
function vbsString(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}

/** XML 文本转义：任务名/路径里出现 `&` `<` `"` 时不能让 XML 变成非法文档。 */
function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 生成「以隐藏窗口启动 NapCat」的包装脚本（VBScript 源码）。
 *
 * 为什么非得这么绕（对着 NapCat 的产物读出来的）：`launcher.bat` 发现自己不是管理员时，
 * 会用 `launcher-elevate.ps1` **把 `wt.exe`（Windows Terminal）提权起来**再重跑自己 ——
 * 而 Windows Terminal 压根没有「隐藏启动」这回事，那个窗口一定会出现在任务栏里。
 * 反过来，`wscript.exe` 是 GUI 子系统程序（自己不带控制台），再用 `WshShell.Run` 的
 * 窗口样式 `0`（SW_HIDE）拉起 `launcher.bat`，那个控制台**从创建那一刻**就是隐藏的。
 *
 * 本机实测（拿 `cmd.exe /c ping` 当探针）：普通 `Start-Process cmd` 起来的进程主窗口句柄
 * 非 0，经这条路起来的句柄是 0 —— 也就是说窗口从头到尾没出现过。
 *
 * 第三个参数 `True` = 等它退出：计划任务里这个进程树因此一直活着，NapCat 也一直活着；
 * 写 `False` 的话 wscript 立刻退出，子进程在有些环境下会被一起回收。
 *
 * @param options.launcher - 启动器 `.bat` 的绝对路径。
 * @param options.qq - 机器人 QQ 号；给了就写进命令行（`-q <号>` = 快速登录）。
 * @param options.napcatDir - NapCat 根目录（当包装脚本的工作目录；`launcher.bat` 自己也会 `cd`）。
 * @returns VBScript 源码。**落盘要用 UTF-16LE + BOM**（`writeTextAtomicUtf16`）：WSH 读
 *   没有 BOM 的脚本时按系统 ANSI 代码页解码，注释与中文路径都会变成乱码。
 */
export function hiddenWrapperVbs({ launcher, qq = '', napcatDir = '' } = {}) {
  const file = String(launcher ?? '').trim();
  const wanted = String(qq ?? '').trim();
  const dir = String(napcatDir ?? '').trim();
  // 命令行走 `cmd.exe /s /c`，**不**把 .bat 直接交给 WshShell.Run：
  //   - 直接 Run 一个 .bat 会走**文件关联**（ShellExecute）。从下载来的 zip 里解压出来的
  //     .bat 带 Mark-of-the-Web，那一步会弹「打开文件 - 安全警告」的模态框等人点；
  //     我们没有窗口，于是表现是「什么都没发生」，还查不出原因。关联被改坏（指向编辑器）同理。
  //   - 显式 cmd 是直接 CreateProcess，窗口样式 0 由 conhost 照办，也不依赖任何关联。
  // `/s` 是让 cmd 按老规矩处理引号：`/c ""路径" 参数"` 里最外那对引号会被剥掉，
  // 带空格的路径因此能正确落到 bat 上（实测：`sh.Run "cmd.exe /s /c ""...""", 0, True`）。
  const inner = `${vbsString(file)}${wanted.length > 0 ? ` -q ${wanted}` : ''}`;
  const command = `cmd.exe /s /c "${inner}"`;
  return [
    "' 由 dsh-qq-bridge 的 napcat-setup 生成：以**隐藏窗口**启动 NapCat（别手改，改完重跑那个脚本）。",
    "' 原理：wscript.exe 是 GUI 子系统程序（自己没有控制台），再用 WshShell.Run 的",
    "' 窗口样式 0（SW_HIDE）拉起命令 —— 那个黑框框从创建那一刻就是隐藏的。",
    "' 第三个参数 True = 等它退出：计划任务里这个进程树一直活着，NapCat 才一直活着。",
    "' 它必须用 `wscript.exe //B` 拉起来：//B = 出错时给退出码，而不是弹一个没人能看见的",
    "' 模态对话框停在那儿（本地实测：同一份脚本加 //B 跑通，不加就卡住等点）。",
    'Option Explicit',
    'Dim sh',
    'Set sh = CreateObject("WScript.Shell")',
    ...(dir.length > 0 ? [`sh.CurrentDirectory = ${vbsString(dir)}`] : []),
    `sh.Run ${vbsString(command)}, 0, True`,
    '',
  ].join('\r\n');
}

/**
 * 「隐藏启动」的计划：**提权 + 不弹窗**，一次 UAC 换一个从头到尾不出现的控制台。
 *
 * 为什么不复用 {@link startPlan} 的 `-WindowStyle Hidden`：那条路把窗口样式交给
 * ShellExecute，而**控制台窗口要不要隐藏是 conhost 说了算**，实测并不可靠；更要紧的是
 * 它每次都要问一次 UAC。这里改成提权跑 `wscript.exe`（GUI 宿主，连「要隐藏的控制台」
 * 都没有），窗口的问题就不存在了。
 *
 * 想要「连 UAC 也不问」，就装计划任务（{@link scheduledTaskInstallPlan}）——
 * 那条路是注册一次、以后每次以管理员身份静默拉起。
 *
 * @param options.platform - 目标平台（默认当前进程的）。
 * @param options.wrapper - {@link hiddenWrapperVbs} 落盘后的 `.vbs` 路径。
 * @param options.qq - 只用来写那句给人看的描述（号码已经烘进包装脚本里了）。
 * @returns `{ command, args, describe }` 或 `{ unsupported }`。
 */
export function hiddenStartPlan({ platform = process.platform, wrapper, qq = '' } = {}) {
  if (platform !== 'win32') {
    return { unsupported: `隐藏启动只对 Windows 有意义（当前平台是 ${platform}）` };
  }
  const file = String(wrapper ?? '').trim();
  if (file.length === 0) {
    return { unsupported: `隐藏启动需要包装脚本 ${HIDDEN_WRAPPER_NAME}（一键脚本会生成它）；不想用它就退回 --window min` };
  }
  const wanted = String(qq ?? '').trim();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // `//B` 是**必须**的：没有它，脚本一出错 WSH 就弹一个模态错误框并停在那儿等人点 ——
    // 而我们连窗口都没有，等于机器人静默停住、还没有任何日志。`//B`（批处理模式）把错误
    // 降级成退出码，也不再显示 WSH 自己的图标/对话框（本地实测：同一份脚本加 `//B` 跑通，
    // 不加就是卡住等点）。
    // 路径**要自己带一对引号**：`Start-Process -ArgumentList` 收数组时只是用空格拼起来，
    // 不会替我们加引号 —— `C:\Program Files\...` 那种路径会被 wscript 拆成两个参数。
    `Start-Process -FilePath ${psQuote('wscript.exe')} -ArgumentList @(${psQuote('//B')}, ${psQuote(`"${file}"`)}) -Verb RunAs -WindowStyle Hidden`,
  ].join('; ');
  return {
    ...elevatedCommand(script),
    describe: `以管理员身份、无窗口启动 NapCat（包装脚本 ${file}${wanted.length > 0 ? `；快速登录 ${wanted}` : ''}；UAC 弹窗点「是」）`,
  };
}

/**
 * 生成计划任务的 XML：登录时以管理员身份、无窗口跑那个包装脚本。
 *
 * 为什么用 XML 而不是 `Register-ScheduledTask`：后者走 CIM/WMI，在受限环境（比如 DSH 自己的
 * 沙箱）里会被拦下（实测 `无法从客户端中访问 CIM 资源`），而 `schtasks.exe /create /xml`
 * 走的是任务计划服务的 RPC。XML 还有个好处：**它是一份能读的产物**，用户可以自己看、
 * 自己改、自己 `schtasks /create` 一遍。
 *
 * 几个字段是刻意的：
 *   - `RunLevel: HighestAvailable`：不提权时 QQ 会在注入后崩在 QQNT.dll（见 {@link startPlan}）；
 *   - `LogonType: InteractiveToken`：**必须跑在用户会话里**。NapCat 要拉起 QQ.exe 并注入，
 *     「不管用户是否登录都运行」会把进程放进会话 0，那里面 QQ 起不来；
 *   - `MultipleInstancesPolicy: IgnoreNew`：两份 NapCat 会抢同一个 QQ、同一个端口；
 *   - `ExecutionTimeLimit: PT0S`：默认 72 小时会被任务计划服务掐掉，而机器人要一直挂着。
 *
 * @param options.taskName - 任务名（默认 {@link TASK_NAME}）。
 * @param options.wrapper - 包装脚本 `.vbs` 的绝对路径。
 * @param options.napcatDir - 工作目录（NapCat 根目录）。
 * @param options.userId - `域\用户名`（计划任务里必须写成这个形状）。
 * @param options.description - 写进任务描述的说明。
 * @returns XML 文本；`wrapper` 或 `userId` 缺失时 undefined（宁可让调用方报错，也不产出一份坏 XML）。
 */
export function scheduledTaskXml({ taskName = TASK_NAME, wrapper, napcatDir = '', userId, description = TASK_DESCRIPTION } = {}) {
  const file = String(wrapper ?? '').trim();
  const user = String(userId ?? '').trim();
  if (file.length === 0 || user.length === 0) return undefined;
  const dir = String(napcatDir ?? '').trim();
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(description)}</Description>`,
    `    <URI>\\${xmlEscape(taskName)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>wscript.exe</Command>',
    // `//B`：批处理模式 —— 出错时给退出码，而不是弹一个没人能看见的模态对话框（见 hiddenStartPlan）。
    `      <Arguments>//B "${xmlEscape(file)}"</Arguments>`,
    ...(dir.length > 0 ? [`      <WorkingDirectory>${xmlEscape(dir)}</WorkingDirectory>`] : []),
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * 注册（或覆盖）计划任务：**一次 UAC，以后静默提权启动**。
 *
 * `schtasks /create /xml` 需要管理员，所以这一步自己也要提权一次 —— 装完这一次之后，
 * 以后启动 NapCat 就只走 `schtasks /run`（见 {@link scheduledTaskRunPlan}），不再弹 UAC。
 *
 * @param options.platform - 目标平台（默认当前进程的）。
 * @param options.taskName - 任务名（默认 {@link TASK_NAME}）。
 * @param options.xmlPath - {@link scheduledTaskXml} 落盘后的路径。
 * @returns `{ command, args, describe }` 或 `{ unsupported }`。
 */
export function scheduledTaskInstallPlan({ platform = process.platform, taskName = TASK_NAME, xmlPath } = {}) {
  if (platform !== 'win32') return { unsupported: `计划任务只在 Windows 上有意义（当前平台是 ${platform}）` };
  const file = String(xmlPath ?? '').trim();
  if (file.length === 0) return { unsupported: '计划任务的 XML 还没写出来，没法注册' };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `& schtasks.exe /Create /TN ${psQuote(taskName)} /XML ${psQuote(file)} /F`,
    'exit $LASTEXITCODE',
  ].join('; ');
  return {
    ...elevatedCommand(script),
    taskName,
    describe: `注册计划任务「${taskName}」（登录时以管理员身份、无窗口启动 NapCat；UAC 弹窗点「是」，只需这一次）`,
  };
}

/**
 * 删掉计划任务（同样要管理员：任务是以最高权限注册的）。
 *
 * @param options.platform - 目标平台（默认当前进程的）。
 * @param options.taskName - 任务名（默认 {@link TASK_NAME}）。
 * @returns `{ command, args, describe }` 或 `{ unsupported }`。
 */
export function scheduledTaskDeletePlan({ platform = process.platform, taskName = TASK_NAME } = {}) {
  if (platform !== 'win32') return { unsupported: `计划任务只在 Windows 上有意义（当前平台是 ${platform}）` };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `& schtasks.exe /Delete /TN ${psQuote(taskName)} /F`,
    'exit $LASTEXITCODE',
  ].join('; ');
  return {
    ...elevatedCommand(script),
    taskName,
    describe: `删除计划任务「${taskName}」（UAC 弹窗点「是」）`,
  };
}

/**
 * 查询计划任务：`verbose` 为真时把详情打出来（状态、上次结果、下次运行时间），
 * 否则只用退出码回答「装过没有」—— 脚本靠它决定「隐藏启动是走任务，还是走一次 UAC」。
 *
 * 查询**不需要提权**（自己的任务自己看得见），所以这里是直接调 `schtasks.exe`。
 *
 * @param options.taskName - 任务名（默认 {@link TASK_NAME}）。
 * @param options.verbose - 是否要详情。
 * @returns `{ command, args, describe }`。
 */
export function scheduledTaskQueryPlan({ taskName = TASK_NAME, verbose = false } = {}) {
  const args = ['/Query', '/TN', String(taskName)];
  if (verbose) args.push('/V', '/FO', 'LIST');
  return {
    command: 'schtasks.exe',
    args,
    describe: verbose ? `查询计划任务「${taskName}」的详情` : `查询计划任务「${taskName}」是否存在`,
  };
}

/**
 * 立刻启动一次计划任务：**不提权、不弹 UAC、也没有窗口** —— 任务自己的最高权限生效。
 * 这是装了计划任务之后「手动再启动一次 NapCat」的正路。
 *
 * @param options.taskName - 任务名（默认 {@link TASK_NAME}）。
 * @returns `{ command, args, describe }`。
 */
export function scheduledTaskRunPlan({ taskName = TASK_NAME } = {}) {
  return {
    command: 'schtasks.exe',
    args: ['/Run', '/TN', String(taskName)],
    describe: `启动计划任务「${taskName}」（以管理员身份、无窗口；不会再问 UAC）`,
  };
}
