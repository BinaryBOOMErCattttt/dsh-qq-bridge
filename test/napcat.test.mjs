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
  hiddenStartPlan,
  hiddenWrapperVbs,
  inspectNapcat,
  inspectOnebotConfig,
  looksLikeNapcatShell,
  repairNapcat,
  scheduledTaskDeletePlan,
  scheduledTaskInstallPlan,
  scheduledTaskQueryPlan,
  scheduledTaskRunPlan,
  scheduledTaskXml,
  startPlan,
  TASK_NAME,
  webuiTarget,
  withAutoLoginAccount,
  withNapcatLogging,
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

/** 造一个「刚解压、还没登录过」的假 NapCat：只有自带的启动件，连 config 目录都没有。 */
async function fakeNapcatShell() {
  const root = await mkdtemp(join(tmpdir(), 'qq-napcat-shell-'));
  await writeFile(join(root, 'launcher.bat'), '@echo off\r\n', 'utf8');
  await writeFile(join(root, 'napcat.mjs'), 'export {};\n', 'utf8');
  return root;
}

/** 把 `startPlan` 那条 `-EncodedCommand` 解回来，方便断言里面到底写了什么。 */
function decodePlan(plan) {
  const index = plan.args.indexOf('-EncodedCommand');
  assert.notEqual(index, -1, 'ps 命令要走 Base64 传，避免层层引号转义');
  return Buffer.from(plan.args[index + 1], 'base64').toString('utf16le');
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
  // 「还没登录过账号」要能被结构化地认出来：调用方靠它记 info 而不是 warn（发布版安装流程里
  // 那是正常中间态），所以不许只靠文案去猜。
  assert.equal(noAccount.noAccount, true);
  assert.match((await inspectNapcat({ dir: join(tmpdir(), 'nope-does-not-exist'), endpoint: 'ws://127.0.0.1:3001' })).reason, /目录不存在/);
  assert.equal(
    (await inspectNapcat({ dir: join(tmpdir(), 'nope-does-not-exist'), endpoint: 'ws://127.0.0.1:3001' })).noAccount,
    undefined,
    '目录不存在是另一回事，不能也被当成「还没登录」',
  );
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
  // 刚解压、还没登录过的 NapCat（config 目录在、里面没有账号配置）：`unknown` + `noAccount`。
  const fresh = await fakeNapcatShell();
  await mkdir(join(fresh, 'config'), { recursive: true });
  const notLoggedIn = await repairNapcat({ dir: join(fresh, 'config'), endpoint: 'ws://127.0.0.1:3001', autoConfig: true });
  assert.equal(notLoggedIn.action, 'unknown');
  assert.equal(notLoggedIn.noAccount, true);
  assert.equal(missing.noAccount, false, '目录都不存在时不该冒充「还没登录」');
});

test('looksLikeNapcatShell：靠 NapCat 自带的启动件认出「刚解压的 NapCat」', () => {
  assert.equal(looksLikeNapcatShell(['launcher.bat', 'napcat.mjs', 'node_modules']), true);
  assert.equal(looksLikeNapcatShell(['launcher-user.bat']), true);
  assert.equal(looksLikeNapcatShell(['launcher-elevate.ps1']), true);
  assert.equal(looksLikeNapcatShell(['launcher-win10.bat']), true);
  assert.equal(looksLikeNapcatShell(['NapCatWinBootMain.exe', 'NapCatWinBootHook.dll']), true);
  assert.equal(looksLikeNapcatShell(['loadNapCat.js']), true);
  // 弱判据放宽的只是「还没有 config」，不是「随便什么空目录都算」。
  assert.equal(looksLikeNapcatShell([]), false);
  assert.equal(looksLikeNapcatShell(undefined), false);
  assert.equal(looksLikeNapcatShell(['config', 'README.md', 'launcher.md']), false);
});

test('findNapcatDir：强判据优先（有账号配置），弱判据兜底（刚解压、只有启动件）', async () => {
  const good = await fakeNapcat(EMPTY_CONFIG, { qq: '10001' });
  const bare = await mkdtemp(join(tmpdir(), 'qq-napcat-bare-'));
  await mkdir(join(bare, 'config'), { recursive: true });
  const fresh = await fakeNapcatShell();
  const nothing = join(tmpdir(), 'qq-napcat-none-does-not-exist');
  // 空的 config 目录（没账号配置、也没启动件）要跳过，取真正有账号配置的那个。
  assert.equal(await findNapcatDir([nothing, bare, good.root]), good.root);
  // 发布版安装流程里就是这一种：NapCat 刚解压、还没登录过，config 目录都不存在。
  assert.equal(await findNapcatDir([nothing, bare, fresh]), fresh, '刚解压的 NapCat 也要认出来，否则 --qq 那条路走不到');
  // 两种证据都在时按候选顺序取第一个（调用方的候选表就是「越具体越优先」）。
  assert.equal(await findNapcatDir([fresh, good.root]), fresh);
  assert.equal(await findNapcatDir([bare]), undefined);
  assert.equal(await findNapcatDir([]), undefined);
  assert.equal(await findNapcatDir(undefined), undefined);
});

test('withAutoLoginAccount：只动 autoLoginAccount，其余字段与幂等都要守住', () => {
  const config = { host: '::', port: 6099, token: 'abc', autoLoginAccount: '' };
  const set = withAutoLoginAccount(config, '123456789');
  assert.equal(set.changed, true);
  assert.equal(set.config.autoLoginAccount, '123456789');
  assert.equal(config.autoLoginAccount, '', '原对象不能被就地修改（写盘前还要拿它做备份对账）');
  assert.equal(set.config.token, 'abc', '不能顺手抹掉 WebUI 的 token');
  assert.equal(set.config.port, 6099);
  assert.equal(withAutoLoginAccount(set.config, '123456789').changed, false, '幂等：已经对了就不该再写盘');
  // 从别处粘过来的号码可能带空白：按去空白后的值写。
  assert.equal(withAutoLoginAccount(config, '  123456789  ').config.autoLoginAccount, '123456789');
  // 不给号 = 什么都不做（注意：不是「把已有的清空」—— 那会把用户设好的快速登录抹掉）。
  assert.equal(withAutoLoginAccount(config, '').changed, false);
  assert.equal(withAutoLoginAccount(config, undefined).changed, false);
  assert.equal(withAutoLoginAccount({ autoLoginAccount: '123' }, '').config.autoLoginAccount, '123');
  // 认不出形状的输入当作空配置处理，而不是抛错（用户的文件可能被编辑成 `[]`）。
  assert.equal(withAutoLoginAccount(null, '123').config.autoLoginAccount, '123');
  assert.equal(withAutoLoginAccount([], '123').config.autoLoginAccount, '123');
});

test('startPlan：Windows 上以管理员身份启动，并带上快速登录与窗口样式', () => {
  const plan = startPlan({ platform: 'win32', launcher: 'C:\\a b\\NapCat.Shell\\launcher.bat', qq: '123456789', windowMode: 'normal' });
  assert.equal(plan.command, 'powershell.exe');
  const script = decodePlan(plan);
  assert.match(script, /Start-Process/);
  // 不提权时 QQ 会在注入后崩在 QQNT.dll（0x80000003）—— 实测结论，必须钉住。
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /-WindowStyle Normal/);
  assert.match(script, /-q/);
  assert.match(script, /123456789/);
  // 路径里有空格也必须原样进去（走 Base64 就是为了这个）。
  assert.match(script, /C:\\a b\\NapCat\.Shell\\launcher\.bat/);
  assert.match(plan.describe, /管理员/);
  assert.match(plan.describe, /123456789/);
  // 认不出的取值按默认（最小化）处理，别把用户拒在门外。
  assert.match(decodePlan(startPlan({ platform: 'win32', launcher: 'x.bat', windowMode: 'min' })), /-WindowStyle Minimized/);
  assert.match(decodePlan(startPlan({ platform: 'win32', launcher: 'x.bat', windowMode: '乱写' })), /-WindowStyle Minimized/);
  // 没给 QQ 就只启动、不快速登录（`-ArgumentList @()` 是合法的空参数表）。
  const plain = decodePlan(startPlan({ platform: 'win32', launcher: 'x.bat' }));
  assert.doesNotMatch(plain, /-q/);
  assert.match(plain, /-ArgumentList @\(\)/);
  // 其它平台 / 没有启动器：给一句能读的话，而不是抛错。
  assert.match(startPlan({ platform: 'linux', launcher: 'x.bat' }).unsupported, /Windows/);
  assert.match(startPlan({ platform: 'win32', launcher: '' }).unsupported, /启动器/);
  // hidden 不是这条路的样式：它换成了 GUI 宿主的包装脚本（见下一组用例），
  // 少给一个包装脚本时必须说清楚去哪拿，而不是悄悄退化成「最小化」。
  assert.match(startPlan({ platform: 'win32', launcher: 'x.bat', windowMode: 'hidden' }).unsupported, /包装脚本/);
});

/** 把生成的 VBS 里 `sh.Run` 那一行解回命令行（VBS 的引号是双写的，这里还原成一个）。 */
function vbsRunCommand(vbs) {
  const line = vbs.split('\r\n').find((item) => item.startsWith('sh.Run '));
  assert.notEqual(line, undefined, 'VBS 里必须有 sh.Run 那一行');
  const literal = line.slice('sh.Run '.length);
  return literal.slice(1, literal.lastIndexOf('", 0, True')).replace(/""/g, '"');
}

test('hiddenWrapperVbs：隐藏窗口 + 等它退出，命令行走 cmd.exe /s /c', () => {
  const vbs = hiddenWrapperVbs({ launcher: 'C:\\a b\\NapCat.Shell\\launcher.bat', qq: '123456789', napcatDir: 'C:\\a b\\NapCat.Shell' });
  assert.match(vbs, /Option Explicit/);
  assert.match(vbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
  // `, 0, True` 是这条路的全部要点：0 = 窗口隐藏，True = 等它退出（进程树因此一直活着）。
  assert.match(vbs, /, 0, True\r\n/);
  assert.ok(vbs.includes('sh.CurrentDirectory = "C:\\a b\\NapCat.Shell"'), '包装脚本要站到 NapCat 目录里');
  // 走 cmd.exe /s /c 而不是把 .bat 直接交给 WshShell.Run：后者走文件关联（ShellExecute），
  // 从下载来的 zip 里解压出来的 .bat 带 Mark-of-the-Web，会弹一个我们看不见的模态警告框。
  assert.equal(vbsRunCommand(vbs), 'cmd.exe /s /c ""C:\\a b\\NapCat.Shell\\launcher.bat" -q 123456789"');
  // 中文 + 空格的路径要能原样穿过去（编码那半边由 filestore 的 UTF-16 用例钉住）。
  assert.equal(vbsRunCommand(hiddenWrapperVbs({ launcher: 'C:\\程序 目录\\launcher.bat', qq: '1' })), 'cmd.exe /s /c ""C:\\程序 目录\\launcher.bat" -q 1"');
  // 不给号就不带 -q（那时 NapCat 自己走二维码登录）。
  assert.equal(vbsRunCommand(hiddenWrapperVbs({ launcher: 'x.bat' })), 'cmd.exe /s /c ""x.bat""');
  // 没有目录可站时不硬写一行空的 CurrentDirectory。
  assert.ok(!hiddenWrapperVbs({ launcher: 'x.bat' }).includes('CurrentDirectory'));
});

test('hiddenStartPlan：提权跑 wscript（GUI 宿主，压根没有要隐藏的控制台）', () => {
  const plan = hiddenStartPlan({ platform: 'win32', wrapper: 'C:\\a b\\hidden.vbs', qq: '123456789' });
  assert.equal(plan.command, 'powershell.exe');
  const script = decodePlan(plan);
  assert.match(script, /Start-Process/);
  assert.match(script, /-Verb RunAs/, '还是要管理员：不提权 QQ 会崩在 QQNT.dll');
  assert.match(script, /wscript\.exe/);
  // `//B` 必须在：没有它 WSH 出错时会弹一个看不见的模态框停在那儿（实测四次里挂一两次）。
  assert.match(script, /\/\/B/);
  // 路径也**必须自己带引号**：`-ArgumentList` 收数组时只是空格拼接，不会替我们加引号，
  // 带空格的路径（`C:\Program Files\...`）会被拆成两个参数。
  assert.match(script, /"C:\\a b\\hidden\.vbs"/);
  assert.match(plan.describe, /无窗口/);
  // 缺包装脚本就别硬来：说清楚退路是 --window min。
  assert.match(hiddenStartPlan({ platform: 'win32', wrapper: '' }).unsupported, /--window min/);
  assert.match(hiddenStartPlan({ platform: 'linux', wrapper: 'x.vbs' }).unsupported, /Windows/);
});

test('scheduledTaskXml：登录触发 + 最高权限 + 会话内运行 + 无时间上限', () => {
  const xml = scheduledTaskXml({ wrapper: 'C:\\a b\\hidden.vbs', napcatDir: 'C:\\a b\\NapCat.Shell', userId: 'PC\\shelter' });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>PC\\shelter<\/UserId>/);
  // 三条不能省的：最高权限（不崩）、InteractiveToken（要跑在用户会话里才拉得起 QQ）、
  // IgnoreNew（两份 NapCat 会抢同一个 QQ 与端口）、PT0S（默认 72 小时会被掐掉）。
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  // 参数里的 `//B` 与 `hiddenStartPlan` 同款：出错要有退出码，别弹看不见的模态框。
  assert.match(xml, /<Arguments>\/\/B "C:\\a b\\hidden\.vbs"<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\a b\\NapCat\.Shell<\/WorkingDirectory>/);
  assert.match(xml, new RegExp(`<URI>\\\\${TASK_NAME}</URI>`));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  // 转义：路径里带 & 时不能让 XML 变成非法文档（schtasks 会直接拒绝）。
  assert.match(scheduledTaskXml({ wrapper: 'C:\\a&b\\h.vbs', userId: 'PC\\u' }), /C:\\a&amp;b\\h\.vbs/);
  // 缺关键入参时宁可不产出，也别写一份坏任务出去。
  assert.equal(scheduledTaskXml({ wrapper: '', userId: 'PC\\u' }), undefined);
  assert.equal(scheduledTaskXml({ wrapper: 'x.vbs', userId: '' }), undefined);
});

test('计划任务的三条命令：注册要提权、查询与启动不提权', () => {
  // 显式给 platform：这三个 plan 的默认值是「当前平台」，在 Linux 上跑测试时
  // 不写就成了「不支持计划任务」，验不到 Windows 那三分支。
  const install = scheduledTaskInstallPlan({ platform: 'win32', taskName: 'dsh-qq-bridge-napcat', xmlPath: 'C:\\a b\\task.xml' });
  assert.equal(install.command, 'powershell.exe');
  const script = decodePlan(install);
  assert.match(script, /schtasks\.exe \/Create \/TN 'dsh-qq-bridge-napcat' \/XML 'C:\\a b\\task\.xml' \/F/);
  // 退出码必须透出来：脚本靠它判断「注册成了没有」（UAC 被取消时是非零）。
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.match(install.describe, /UAC/);
  assert.match(scheduledTaskInstallPlan({ platform: 'linux', xmlPath: 'x' }).unsupported, /Windows/);
  assert.match(scheduledTaskInstallPlan({ platform: 'win32', xmlPath: '' }).unsupported, /XML/);
  assert.match(scheduledTaskInstallPlan({ platform: 'win32', xmlPath: '' }).unsupported, /XML/);
  assert.match(decodePlan(scheduledTaskDeletePlan({ platform: 'win32', taskName: 'x' })), /\/Delete \/TN 'x' \/F/);
  // 查询与启动都是直接调 schtasks（自己的任务自己看得见、自己跑得动），不用绕 PowerShell。
  assert.equal(scheduledTaskQueryPlan({ taskName: 'x' }).command, 'schtasks.exe');
  assert.deepEqual(scheduledTaskQueryPlan({ taskName: 'x' }).args, ['/Query', '/TN', 'x']);
  assert.deepEqual(scheduledTaskQueryPlan({ taskName: 'x', verbose: true }).args, ['/Query', '/TN', 'x', '/V', '/FO', 'LIST']);
  assert.deepEqual(scheduledTaskRunPlan({ taskName: 'x' }).args, ['/Run', '/TN', 'x']);
});

test('withNapcatLogging：只动那两个开关，其余字段与幂等都要守住', () => {
  const config = { fileLog: false, consoleLog: true, fileLogLevel: 'debug', bypass: { hook: false } };
  const patched = withNapcatLogging(config, { consoleLog: false, fileLog: true });
  assert.equal(patched.changed, true);
  assert.equal(patched.config.consoleLog, false);
  assert.equal(patched.config.fileLog, true);
  // 原对象不能被就地改（写盘前还要拿它做备份对账），用户自己调过的字段也不能被顺手抹掉。
  assert.equal(config.consoleLog, true);
  assert.equal(patched.config.fileLogLevel, 'debug');
  assert.deepEqual(patched.config.bypass, { hook: false });
  assert.equal(withNapcatLogging(patched.config).changed, false, '幂等：已经是写文件了就不再写盘');
  // 认不出形状的输入当空配置处理，而不是抛错。
  assert.equal(withNapcatLogging(null).config.consoleLog, false);
  assert.equal(withNapcatLogging([]).config.fileLog, true);
});

test('webuiTarget：0.0.0.0 / :: 要换成本机能访问的地址，IPv6 要加方括号', () => {
  assert.deepEqual(webuiTarget({ host: '::', port: 6099, token: 'abc' }), { url: 'http://127.0.0.1:6099', host: '::', port: 6099, token: 'abc' });
  assert.equal(webuiTarget({ host: '0.0.0.0', port: 6099 }).url, 'http://127.0.0.1:6099');
  assert.equal(webuiTarget({ port: 6099 }).url, 'http://127.0.0.1:6099', '没写 host 时 NapCat 默认是 ::');
  assert.equal(webuiTarget({ host: '192.168.1.5', port: 7000 }).url, 'http://192.168.1.5:7000');
  assert.equal(webuiTarget({ host: 'fe80::1', port: 6099 }).url, 'http://[fe80::1]:6099');
  // 人手改过的文件里端口可能带引号：是数字就认（与 settings.js「强制类型」同一口径）。
  assert.equal(webuiTarget({ port: '6099' }).url, 'http://127.0.0.1:6099');
  // 端口读不出来时宁可不给地址：打印一个假地址比不打印更糟。
  assert.equal(webuiTarget({ host: '::' }), undefined);
  assert.equal(webuiTarget({ port: '' }), undefined);
  assert.equal(webuiTarget({ port: 70000 }), undefined);
  assert.equal(webuiTarget(null), undefined);
});
