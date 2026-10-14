/**
 * NapCat 那一侧配置的探测与幂等写入（`napcat.js`）。
 *
 * 这个模块的存在理由是「机器人为什么不回复」最难自查的那一环：插件这边全都配好了，
 * 但另一个软件（NapCat）里没有一条启用的 WebSocket 服务器 —— 现象只是「它不说话」。
 * 所以这里的用例分两半：
 *
 *   1. **纯函数**（解析 endpoint、认账号文件、判「够不够用」、幂等改写）：判据的每一条
 *      边界都直接钉住，因为它们决定「要不要动用户的文件」；
 *   2. **真的落盘**（`repairNapcat` 写在临时目录里）：备份有没有产生、改完再跑一次
 *      会不会又改一遍（幂等）、坏 JSON 会不会被覆盖 —— 这三件事坏掉都会**毁掉用户
 *      自己的 NapCat 配置**，比「功能不生效」严重得多。
 *
 * 不 spawn 任何子进程，也不碰真的 NapCat。
 *
 * 运行：node --test test/napcat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  accountFiles,
  desiredServer,
  endpointTarget,
  findNapcatDir,
  inspectNapcat,
  inspectOnebotConfig,
  repairNapcat,
  withWebsocketServer,
} from '../napcat.js';

/** 造一个「已经有账号」的假 NapCat 目录：`<root>/config/onebot11_<qq>.json`。 */
async function fakeNapcat(config = {}, { qq = '10001', extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-napcat-'));
  const dir = join(root, 'config');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `onebot11_${qq}.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  for (const [name, payload] of Object.entries(extra)) {
    await writeFile(join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return { root, dir, file };
}

/** 一份「什么都没配」的 onebot11 配置（与仓库里那份实测产物同形）。 */
const EMPTY_CONFIG = {
  network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [], plugins: [] },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
  imageDownloadProxy: '',
  timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
};

test('endpointTarget：只认 ws/wss，端口越界或缺失都不猜', () => {
  assert.deepEqual(endpointTarget('ws://127.0.0.1:3001'), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(endpointTarget('wss://napcat.example.com:443/onebot'), { host: 'napcat.example.com', port: 443 });
  // 没有端口：解析得出来主机，但端口是 undefined —— 调用方必须自己去拒绝，而不是拿
  // 一个默认端口去改别的软件的配置。
  assert.deepEqual(endpointTarget('ws://127.0.0.1'), { host: '127.0.0.1', port: undefined });
  for (const bad of ['', '   ', 'http://127.0.0.1:3001', '127.0.0.1:3001', 'ws://:3001', 'ws://127.0.0.1:0', 'ws://127.0.0.1:70000']) {
    assert.equal(endpointTarget(bad), undefined, `必须拒绝: ${JSON.stringify(bad)}`);
  }
});

test('accountFiles：只认 onebot11_<QQ>.json（网络配置在那个文件里）', () => {
  const names = ['onebot11_10001.json', 'napcat_10001.json', 'napcat_protocol_10001.json', 'webui.json', 'onebot11_abc.json', 'onebot11_10002.json'];
  assert.deepEqual(accountFiles(names), [
    { qq: '10001', file: 'onebot11_10001.json' },
    { qq: '10002', file: 'onebot11_10002.json' },
  ]);
  assert.deepEqual(accountFiles([]), []);
  assert.deepEqual(accountFiles(undefined), []);
});

test('desiredServer：照 NapCat 自己的 schema 填，只把 enable 打开、reportSelfMessage 关掉', () => {
  const server = desiredServer({ port: 3001 });
  assert.equal(server.name, 'dsh-qq-bridge');
  assert.equal(server.enable, true);
  assert.equal(server.host, '127.0.0.1');
  assert.equal(server.port, 3001);
  assert.equal(server.messagePostFormat, 'array');
  // 这一条是硬要求：开着的话机器人会收到自己发的消息，然后接自己的话。
  assert.equal(server.reportSelfMessage, false);
  assert.equal(server.token, '');
  assert.equal(server.enableForcePushEvent, true);
  assert.equal(server.heartInterval, 30000);
  assert.equal(desiredServer({ port: 3001, token: 'secret' }).token, 'secret');
});

test('inspectOnebotConfig：逐条说清楚「为什么现在连不上」', () => {
  // 一条都没有。
  assert.equal(inspectOnebotConfig(EMPTY_CONFIG, { port: 3001 }).ok, false);
  assert.match(inspectOnebotConfig(EMPTY_CONFIG, { port: 3001 }).reason, /没有配置任何 WebSocket 服务器/);
  // 端口对不上（把已有端口列出来，省得用户去猜）。
  const other = { network: { websocketServers: [{ name: 'x', enable: true, port: 3002, token: '' }] } };
  assert.match(inspectOnebotConfig(other, { port: 3001 }).reason, /3002.*没有一条监听 3001/);
  // 端口对但没启用。
  const disabled = { network: { websocketServers: [{ name: 'x', enable: false, port: 3001, token: '' }] } };
  assert.match(inspectOnebotConfig(disabled, { port: 3001 }).reason, /没有启用/);
  // token 不一致（两个方向都要说清楚，这题最容易查半天）。
  const withToken = { network: { websocketServers: [{ name: 'x', enable: true, port: 3001, token: 'abc' }] } };
  assert.match(inspectOnebotConfig(withToken, { port: 3001, token: '' }).reason, /设了 token/);
  assert.match(inspectOnebotConfig(withToken, { port: 3001, token: 'abd' }).reason, /token 与插件的 accessToken 不一致/);
  // 全对：ok，token 也一致。
  assert.equal(inspectOnebotConfig(withToken, { port: 3001, token: 'abc' }).ok, true);
  // 端口本身没解析出来时不许瞎判（否则会去改一个不属于我们的条目）。
  assert.match(inspectOnebotConfig(withToken, {}).reason, /解析不出端口/);
});

test('inspectOnebotConfig：能连上但不够干净的两处只当 note 记，不算失败', () => {
  const selfEcho = { network: { websocketServers: [{ name: 'x', enable: true, port: 3001, token: '', reportSelfMessage: true }] } };
  const verdict = inspectOnebotConfig(selfEcho, { port: 3001 });
  assert.equal(verdict.ok, true, '开着 reportSelfMessage 是「会接自己的话」，不是「连不上」');
  assert.match(verdict.notes.join('\n'), /reportSelfMessage/);
  const exposed = { network: { websocketServers: [{ name: 'x', enable: true, port: 3001, token: '', host: '0.0.0.0' }] } };
  assert.equal(inspectOnebotConfig(exposed, { port: 3001 }).ok, true);
  assert.match(inspectOnebotConfig(exposed, { port: 3001 }).notes.join('\n'), /监听地址/);
});

test('withWebsocketServer：没命中就追加，命中就原地合并（保留用户自己的字段）', () => {
  const desired = desiredServer({ port: 3001 });
  // 追加：原对象不许被改（写盘前还要拿它做备份对账）。
  const appended = withWebsocketServer(EMPTY_CONFIG, desired);
  assert.equal(appended.changed, true);
  assert.equal(EMPTY_CONFIG.network.websocketServers.length, 0, '原配置不能被就地修改');
  assert.equal(appended.config.network.websocketServers.length, 1);
  // 其它段落一个字段都不动 —— 用户自己的 httpServers / timeout 不能被我们顺手抹掉。
  assert.deepEqual(appended.config.timeout, EMPTY_CONFIG.timeout);
  assert.deepEqual(appended.config.network.websocketClients, []);
  // 命中同名条目：改成我们要的样子，但用户调过的 debug / heartInterval 留着。
  const user = { network: { websocketServers: [{ name: 'dsh-qq-bridge', enable: false, port: 9999, token: '', debug: true, heartInterval: 5000 }] } };
  const merged = withWebsocketServer(user, desired);
  assert.equal(merged.changed, true);
  assert.equal(merged.config.network.websocketServers.length, 1, '不能追加出第二条同端口的服务器');
  assert.deepEqual(merged.config.network.websocketServers[0], {
    name: 'dsh-qq-bridge', enable: true, host: '127.0.0.1', port: 3001,
    messagePostFormat: 'array', reportSelfMessage: false, token: '',
    enableForcePushEvent: true, debug: true, heartInterval: 5000,
  });
  // 幂等：再应用一次，一个字节都不该变。
  assert.equal(withWebsocketServer(merged.config, desired).changed, false);
  // 认不出形状的输入当作空配置处理，而不是抛错（用户的文件可能是 `{}`）。
  assert.equal(withWebsocketServer({}, desired).changed, true);
  assert.equal(withWebsocketServer(null, desired).changed, true);
});

test('inspectNapcat：认账号、读文件、给结论；认不出来时说清楚卡在哪一步', async () => {
  const { dir } = await fakeNapcat(EMPTY_CONFIG, { qq: '12345', extra: { 'napcat_12345.json': {}, 'webui.json': {} } });
  const hit = await inspectNapcat({ dir, endpoint: 'ws://127.0.0.1:3001' });
  assert.equal(hit.found, true);
  assert.equal(hit.account.qq, '12345');
  assert.equal(hit.verdict.ok, false);
  // 指定一个不存在的账号：要把「有哪几个」列出来。
  const missing = await inspectNapcat({ dir, endpoint: 'ws://127.0.0.1:3001', qq: '999' });
  assert.equal(missing.found, false);
  assert.match(missing.reason, /12345/);
  // 目录里一个账号都没有 / 目录不存在 / endpoint 解析不出来。
  const empty = await fakeNapcat(EMPTY_CONFIG, { qq: '1' });
  const noAccount = await inspectNapcat({ dir: empty.root, endpoint: 'ws://127.0.0.1:3001' });
  assert.match(noAccount.reason, /没有 onebot11_/);
  assert.match((await inspectNapcat({ dir: join(tmpdir(), 'nope-does-not-exist'), endpoint: 'ws://127.0.0.1:3001' })).reason, /目录不存在/);
  assert.match((await inspectNapcat({ dir, endpoint: 'ws://127.0.0.1' })).reason, /解析不出/);
  assert.match((await inspectNapcat({ endpoint: 'ws://127.0.0.1:3001' })).reason, /没有配置 napcatDir/);
});

test('repairNapcat：默认一个字节都不改；允许写时先备份、且第二次跑不再动它', async () => {
  const { dir, file } = await fakeNapcat(EMPTY_CONFIG, { qq: '10001' });
  const before = await readFile(file, 'utf8');
  // ① 默认（autoConfig 关闭）：只报告「需要修」，不落盘。
  const dry = await repairNapcat({ dir, endpoint: 'ws://127.0.0.1:3001' });
  assert.equal(dry.action, 'needs-repair');
  assert.match(dry.reason, /没有配置任何 WebSocket 服务器/);
  assert.equal(await readFile(file, 'utf8'), before, '不允许写的时候必须原样不动');
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.bak-')), []);
  // ② 允许写：改好 + 留下备份。
  const written = await repairNapcat({ dir, endpoint: 'ws://127.0.0.1:3001', autoConfig: true, now: Date.UTC(2026, 0, 31, 4, 12) });
  assert.equal(written.action, 'repaired');
  assert.ok(existsSync(written.backup), '改之前必须留一份原文件');
  assert.equal(await readFile(written.backup, 'utf8'), before);
  const patched = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(patched.network.websocketServers[0].port, 3001);
  assert.equal(patched.network.websocketServers[0].reportSelfMessage, false);
  // 备份**文件名**里不能有冒号：Windows 上那种文件根本写不出来（路径本身当然有 `C:`）。
  assert.ok(!basename(written.backup).includes(':'), written.backup);
  // ③ 幂等：已经对了就再也不要动它、也不要产生第二个备份。
  const again = await repairNapcat({ dir, endpoint: 'ws://127.0.0.1:3001', autoConfig: true });
  assert.equal(again.action, 'ok');
  assert.equal((await readdir(dir)).filter((name) => name.includes('.bak-')).length, 1);
});

test('repairNapcat：token 不一致会改回来（这是「连上又立刻掉线」的常见原因）', async () => {
  const withToken = { ...EMPTY_CONFIG, network: { ...EMPTY_CONFIG.network, websocketServers: [{ name: 'x', enable: true, port: 3001, token: 'other' }] } };
  const { dir, file } = await fakeNapcat(withToken, { qq: '10001' });
  const result = await repairNapcat({ dir, endpoint: 'ws://127.0.0.1:3001', token: 'secret', autoConfig: true });
  assert.equal(result.action, 'repaired');
  const patched = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(patched.network.websocketServers.length, 1, '不能追加出一条新的，只能改那一条');
  assert.equal(patched.network.websocketServers[0].token, 'secret');
});

test('repairNapcat：坏 JSON / 不存在的目录都只报告，绝不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-napcat-'));
  const dir = join(root, 'config');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'onebot11_10001.json');
  // 半截 JSON（NapCat 正在写、或者用户手工编辑坏了）：覆盖它会把用户别的设置一起抹掉。
  await writeFile(file, '{ "network": { "websocketServers": [', 'utf8');
  const broken = await repairNapcat({ dir, endpoint: 'ws://127.0.0.1:3001', autoConfig: true });
  assert.equal(broken.action, 'unknown');
  assert.match(broken.reason, /不是合法 JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ "network": { "websocketServers": [');
  // 目录不存在。
  const missing = await repairNapcat({ dir: join(root, 'nope'), endpoint: 'ws://127.0.0.1:3001', autoConfig: true });
  assert.equal(missing.action, 'unknown');
  assert.match(missing.reason, /目录不存在/);
});

test('findNapcatDir：只认「有 config 且有账号配置」的目录，按候选顺序取第一个', async () => {
  const good = await fakeNapcat(EMPTY_CONFIG, { qq: '10001' });
  const bare = await mkdtemp(join(tmpdir(), 'qq-napcat-bare-'));
  await mkdir(join(bare, 'config'), { recursive: true });
  const found = await findNapcatDir([join(tmpdir(), 'qq-napcat-none-'), bare, good.root]);
  assert.equal(found, good.root, '空的 config 目录要跳过，取真正有账号配置的那个');
  assert.equal(await findNapcatDir([bare]), undefined);
  assert.equal(await findNapcatDir([]), undefined);
  assert.equal(await findNapcatDir(undefined), undefined);
});
