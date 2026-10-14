/**
 * NapCat（OneBot v11）那一侧的配置：**探测**它现在长什么样、**幂等**地把它改成我们要的样子。
 *
 * 为什么值得单独一个模块：这是「机器人为什么不回复」里最常见、也最难自己看出来的一环 ——
 * 插件这边配置齐全、WS 也连上了，但 NapCat 里根本没有一条启用的 WebSocket 服务器，
 * 或者端口对不上、token 对不上。用户看到的现象只是「它不说话」，而线索全在另一个
 * 软件的 JSON 文件里。所以这里做两件事：
 *
 *   1. `inspectNapcat`：给一个 NapCat 的 config 目录，读它的 onebot11 配置，回答
 *      「现在这条链路通不通、不通是哪里不通」——**只看，不改**；
 *   2. `repairNapcat`：把缺的那一条写进去（先备份原文件，且**已经对了就一个字节都不动**）。
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
 * 否则它会把「自己刚说的话」当成别人说的，接自己的话（README 里有这一条）。
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
 *   {@link inspectOnebotConfig} 的结果；认不出账号时 `found: false` 且 `reason` 说明原因。
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
    return { found: false, reason: `${dir} 里没有 onebot11_<QQ号>.json（NapCat 还没登录过账号？）` };
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
 *   `'unknown'`（查不出来，`reason` 说明为什么）。
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
  if (found.found !== true) return { action: 'unknown', reason: found.reason, verdict: found.verdict };
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
 * 找一个「像 NapCat 安装目录」的地方：里面有 `config` 目录，且至少有一个 onebot11 配置。
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
    const configDir = join(resolve(dir), 'config');
    if (!existsSync(configDir)) continue;
    let names;
    try {
      names = await readdirImpl(configDir);
    } catch {
      continue;
    }
    if (accountFiles(names).length > 0) return resolve(dir);
  }
  return undefined;
}
