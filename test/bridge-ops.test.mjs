/**
 * 集成测试分册：运维侧（skill 发现 / 凭据轮换 / NapCat 自检）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-ops.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseApiKeyPool } from '../index.js';
import { until, boot, settle, fakeCredentials, startProbeServer, bootKeyRotation, fakeNapcatConfig, NAPCAT_EMPTY } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


// 用例：`.dsh/skills/` 下的每个 skill 都必须是**能被发现**的文件。
//
// frontmatter 写坏的代价是**静默消失**：dsh-skill-filesystem 只在 `ctx.logger.warn`
// 里记一句，而这个部署看不到 cordis logger，模型那边就是「这个 skill 不存在」。
// 所以把「目录名 = name、description 非空、有正文」钉成用例，顺手把 moegirl 依赖的
// 两个接口形状也钉住 —— 换成 `list=search` 那种全文搜索接口会当场失效。
test('.dsh/skills 下的每个 skill 都能被 skill-filesystem 发现', async () => {
  const root = new URL('../.dsh/skills/', import.meta.url);
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.deepEqual(
    dirs.map((entry) => entry.name).sort(),
    ['learn-meme', 'learn-sticker', 'message-digest', 'moegirl', 'update-cognition'],
    '本地 skill 的清单变了就要同步这里（docs/memory.md 的 skill 表也一样）',
  );
  for (const dir of dirs) {
    const text = await readFile(new URL(`${dir.name}/SKILL.md`, root), 'utf8');
    // 行尾刻意宽容 `\r`：Windows 上 core.autocrlf=true 的检出会把文件变成 CRLF，而
    // dsh-skill-filesystem 的真解析器本来就逐行剥 `\r`（它是宽容的）。这里若写死 `\n`，
    // 一整组用例会在 Windows 上假红 —— 「skill 明明能用，测试说它坏了」。
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert.ok(frontmatter, `${dir.name}/SKILL.md 缺 YAML frontmatter，会被整个忽略`);
    const data = yaml.load(frontmatter[1]);
    assert.equal(data.name, dir.name, 'frontmatter 的 name 必须与目录同名');
    assert.ok(
      typeof data.description === 'string' && data.description.trim().length > 0,
      `${dir.name} 的 description 不能为空（skill 目录里只列 description）`,
    );
    assert.ok(text.length > frontmatter[0].length, `${dir.name}/SKILL.md 要有正文`);
    if (dir.name === 'moegirl') {
      // 实测：匿名调 `list=search` / `rest.php/v1/search/page` 都被封，条目网页的正文是
      // 脚本渲染的；只有 opensearch（找条目名）+ prop=extracts（取正文）拿得到东西。
      assert.ok(text.includes('action=opensearch'), 'moegirl 要留着前缀搜索接口');
      assert.ok(text.includes('prop=extracts'), 'moegirl 要留着取正文的接口');
    }
  }
});


/** 池子文件的纯函数边界：注释、空行、CRLF、前后空白、重复。 */
test('parseApiKeyPool keeps order, drops comments/blanks and de-duplicates', () => {
  assert.deepEqual(parseApiKeyPool('# 我的几个 key\n\n  sk-a  \nsk-b\r\nsk-a\n# 尾注\n'), ['sk-a', 'sk-b']);
  assert.deepEqual(parseApiKeyPool(''), []);
  assert.deepEqual(parseApiKeyPool(undefined), []);
  assert.deepEqual(parseApiKeyPool('# 一个 key 都没填\n'), []);
});


/** 轮换的主路径：从当前 key 的下一个开始试，跳过探测失败的，写第一个能用的。 */
test('api key rotation switches to the next key that passes the probe', async () => {
  const keys = {
    a: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    b: 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    c: 'sk-cccccccccccccccccccccccccccccccc',
  };
  const probe = await startProbeServer((key) => (key === keys.c ? 200 : 401));
  const credentials = fakeCredentials({ value: keys.a });
  const { host } = await bootKeyRotation({
    pool: `# 池子\n${keys.a}\n${keys.b}\n${keys.c}\n`,
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(() => credentials.calls.length > 0, 'the rotation to store the next key');
    assert.equal(credentials.store.value, keys.c, 'a 是当前值、b 探测 401，应当换成 c');
    assert.equal(credentials.calls[0].ref, 'DEEPSEEK_API_KEY');
    assert.deepEqual(probe.hits, [keys.b, keys.c], '只探测候选，且按池子顺序（当前值不用探）');
    assert.ok(
      host.list.infos.some((line) => line.includes('switched DEEPSEEK_API_KEY')),
      `expected an info line about the switch, got: ${host.list.infos.join(' | ')}`,
    );
    // 打码是硬要求：日志会进 journal、也会被贴到别处。
    const logs = [...host.list.infos, ...host.list.warnings];
    for (const key of Object.values(keys)) {
      assert.ok(!logs.some((line) => line.includes(key)), `日志里出现了完整的 key：${key}`);
    }
  } finally {
    await probe.close();
  }
});


/** 池子里没有一个能用的 key 时，宁可什么都不做也不能把 bot 换成不可用的状态。 */
test('api key rotation keeps the current key when every candidate fails the probe', async () => {
  const current = 'sk-11111111111111111111111111111111';
  const probe = await startProbeServer(() => 401);
  const credentials = fakeCredentials({ value: current });
  const { host } = await bootKeyRotation({
    pool: 'sk-22222222222222222222222222222222\nsk-33333333333333333333333333333333\n',
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(() => host.list.warnings.some((line) => line.includes('passed the probe')), 'the rotation to give up');
    assert.equal(credentials.calls.length, 0, '一个都不通过就不该写');
    assert.equal(credentials.store.value, current);
  } finally {
    await probe.close();
  }
});


/** key 由启动环境提供时写文件也是白写（环境变量优先级更高）—— 提前说清楚，别假装成功。 */
test('api key rotation stands down when the key comes from the launching environment', async () => {
  const credentials = fakeCredentials({ value: 'sk-fromenv', writable: false, source: 'env' });
  const probe = await startProbeServer(() => 200);
  const { host } = await bootKeyRotation({
    pool: 'sk-44444444444444444444444444444444\nsk-55555555555555555555555555555555\n',
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(
      () => host.list.warnings.some((line) => line.includes('read-only by the launching environment')),
      'the rotation to report the read-only credential',
    );
    assert.equal(credentials.calls.length, 0);
    assert.deepEqual(probe.hits, [], '只读凭据下连探测都不该发生');
  } finally {
    await probe.close();
  }
});


/** 组合里没有凭据服务时只记一条 warn：轮换是顺带的事，不该把插件拖垮。 */
test('api key rotation reports a missing credentials service instead of throwing', async () => {
  const { host } = await bootKeyRotation({ pool: 'sk-a\nsk-b\n', credentials: undefined });
  host.list.timers.fireInterval();
  await until(
    () => host.list.warnings.some((line) => line.includes('credentials service is not visible')),
    'the rotation to report the missing service',
  );
});


/** 池子里没有第二个 key（或全是当前这一个）时什么都不做。 */
test('api key rotation does nothing when the pool holds no other key', async () => {
  const only = 'sk-66666666666666666666666666666666';
  const credentials = fakeCredentials({ value: only });
  const { host } = await bootKeyRotation({ pool: `${only}\n${only}\n`, credentials });
  host.list.timers.fireInterval();
  await until(() => credentials.resolves.length > 0, 'the rotation to read the current key');
  await settle(30);
  assert.equal(credentials.calls.length, 0);
  assert.equal(credentials.store.value, only);
});


/** 池子文件还没建（或还没填 key）时只记一条 info 说清楚该怎么办。 */
test('api key rotation explains a missing pool file without failing', async () => {
  const credentials = fakeCredentials({ value: 'sk-77777777777777777777777777777777' });
  const { host } = await bootKeyRotation({ pool: undefined, credentials });
  host.list.timers.fireInterval();
  await until(() => host.list.infos.some((line) => line.includes('no key pool at')), 'the rotation to explain the missing pool');
  assert.equal(credentials.calls.length, 0);
});


/** 池子配到 cwd 外就整个停用（与 mediaDir / memoryDir 同一套约定），并且不排定时器。 */
test('api key rotation is disabled when the pool file leaves cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-keys-outside-'));
  const credentials = fakeCredentials({ value: 'sk-88888888888888888888888888888888' });
  const { host } = await boot(
    // `proactive: false`：主动说话默认开着，它也会挂一个周期定时器；这条用例数的是轮换那一个。
    { cwd, memory: false, proactive: false, apiKeyRotate: true, apiKeyFile: join(cwd, '..', 'keys.txt') },
    { credentials },
  );
  assert.ok(
    host.list.warnings.some((line) => line.includes('resolves outside cwd')),
    `expected a warning, got: ${host.list.warnings.join(' | ')}`,
  );
  assert.equal(host.list.timers.live('intervals').length, 0, '停用时不该排轮换定时器');
});


/** 默认开着（池子不存在时只是不做事），显式关掉则连定时器都不挂。 */
test('api key rotation is on by default and can be switched off', async () => {
  // 不指定 cwd：boot 会给一个临时目录（写死 `/tmp` 在 Windows 上会落到 `D:\tmp`）。
  const { host } = await boot({ memory: false, proactive: false }, { credentials: fakeCredentials() });
  assert.ok(host.list.infos.some((line) => line.includes('api key rotation: on')));
  assert.equal(host.list.timers.live('intervals').length, 1, '只有一个每日轮换定时器');

  const off = await boot({ memory: false, proactive: false, apiKeyRotate: false }, { credentials: fakeCredentials() });
  assert.ok(off.host.list.infos.some((line) => line.includes('api key rotation is off')));
  assert.equal(off.host.list.timers.live('intervals').length, 0);
});


/** 自检说「NapCat 那边缺一条服务器」时要把原因和修法一起给出来，而不是只说一句「连不上」。 */
test('napcat self-check reports a missing websocket server without touching the file', async () => {
  const napcat = await fakeNapcatConfig(NAPCAT_EMPTY);
  const before = await readFile(napcat.file, 'utf8');
  const { host } = await boot({ napcatDir: napcat.root, memory: false, apiKeyRotate: false });
  await until(
    () => host.list.warnings.some((line) => line.includes('napcat:') && line.includes('没有配置任何 WebSocket 服务器')),
    'the napcat self-check to report the missing server',
  );
  assert.ok(
    host.list.warnings.some((line) => line.includes('napcat-setup.mjs')),
    `说清怎么修：${host.list.warnings.join(' | ')}`,
  );
  // 默认**不写**：那是另一个软件的配置，插件不该悄悄改它。
  assert.equal(await readFile(napcat.file, 'utf8'), before);
});


/** 打开 napcatAutoConfig 才会写：写之前留备份，写完记一句「要重启 NapCat」。 */
test('napcatAutoConfig writes the missing server with a backup and asks for a NapCat restart', async () => {
  const napcat = await fakeNapcatConfig(NAPCAT_EMPTY);
  const before = await readFile(napcat.file, 'utf8');
  const { host, onebot } = await boot({ napcatDir: napcat.root, napcatAutoConfig: true, memory: false, apiKeyRotate: false });
  await until(
    () => host.list.infos.some((line) => line.includes('napcat:') && line.includes('重启 NapCat')),
    'the napcat self-check to write the server',
  );
  const patched = JSON.parse(await readFile(napcat.file, 'utf8'));
  const server = patched.network.websocketServers[0];
  // 端口必须写的是**插件连的那个**（假 OneBot 用的是系统分配的随机端口）。
  assert.equal(server.port, Number(new URL(onebot.endpoint).port));
  assert.equal(server.enable, true);
  assert.equal(server.reportSelfMessage, false);
  const backups = (await readdir(napcat.dir)).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1, '改之前要留一份原文件');
  assert.equal(await readFile(join(napcat.dir, backups[0]), 'utf8'), before);
});
