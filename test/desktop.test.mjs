/**
 * 「装进桌面版 profile」那一步的纯函数（`desktop.js`）。
 *
 * 这两件事都动**用户的文件**，所以用例的重点不是「功能对不对」，而是三条安全性质：
 *
 *   - **幂等**：重复运行的结果必须与跑一次相同（脚本会被反复运行：改了端口、重装、排查）；
 *   - **不碰别人的东西**：`.env` 里用户自己写的变量、`package.json` 里别的依赖与 bundle
 *     都必须原样保留 —— 这两处被写坏，代价是「桌面版起不来」或「配置漂移」；
 *   - **两处一起**：依赖与 `dsh.profile.bundles` 只写一处等于没装（插件不会加载），
 *     所以「只差一个」的状态必须能补上，而不是整个跳过。
 *
 * 不 spawn、不碰磁盘。脚本本身的端到端行为在 README 的 Windows 一节里手工验过。
 *
 * 运行：node --test test/desktop.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEnvBlock, ENV_BLOCK_END, ENV_BLOCK_START, PLUGIN_NAME, withPluginInstalled } from '../desktop.js';

/** 一份典型的 desktop profile manifest（形状照实测的那份）。 */
const MANIFEST = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { 'dsh-our-free-model': '2.1.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-our-free-model'] } },
};

test('applyEnvBlock：第一次写入会追加一段，且不动文件里原有的内容', () => {
  const before = 'MY_OWN_VAR=keepme\n';
  const after = applyEnvBlock(before, { QQBOT_ENDPOINT: 'ws://127.0.0.1:3001', QQBOT_ACCESS_TOKEN: '' });
  assert.ok(after.startsWith(before), '用户自己的行必须原样在前面');
  assert.ok(after.includes(ENV_BLOCK_START) && after.includes(ENV_BLOCK_END));
  // 空值要写成 `KEY=`（显式表达「留空」），不能变成只有键名的怪东西。
  assert.ok(after.includes('QQBOT_ACCESS_TOKEN=\n'), after);
  assert.ok(after.endsWith('\n'));
  // 空文件也照样能用（profile 里还没有 .env 是常态）。
  assert.ok(applyEnvBlock('', { A: '1' }).includes('A=1'));
});

test('applyEnvBlock：重复运行是整段替换，不会一行一行地涨', () => {
  const once = applyEnvBlock('KEEP=1\n', { QQBOT_ENDPOINT: 'ws://127.0.0.1:3001', QQBOT_CWD: 'D:\\qq-bot' });
  const twice = applyEnvBlock(once, { QQBOT_ENDPOINT: 'ws://127.0.0.1:3001', QQBOT_CWD: 'D:\\qq-bot' });
  assert.equal(twice, once, '同样的取值再跑一次必须逐字节相同（否则脚本会一直写盘）');
  // 取值变了就换掉那一段，但仍然只有一段。
  const changed = applyEnvBlock(once, { QQBOT_ENDPOINT: 'ws://127.0.0.1:3002', QQBOT_CWD: 'D:\\qq-bot' });
  assert.equal(changed.split(ENV_BLOCK_START).length - 1, 1);
  assert.ok(changed.includes('QQBOT_ENDPOINT=ws://127.0.0.1:3002'));
  assert.ok(changed.includes('KEEP=1'), '段落之外的内容依然要留着');
  // 段落后面还有用户自己的内容时，替换不能把它吃掉。
  const withTail = applyEnvBlock(`${once}\nTAIL=1\n`, { QQBOT_ENDPOINT: 'ws://127.0.0.1:3009' });
  assert.ok(withTail.includes('TAIL=1'));
  assert.ok(withTail.includes('QQBOT_ENDPOINT=ws://127.0.0.1:3009'));
});

test('applyEnvBlock：CRLF 检出也能正常识别已有的段落', () => {
  const source = `${ENV_BLOCK_START}\r\nQQBOT_ENDPOINT=ws://127.0.0.1:3001\r\n${ENV_BLOCK_END}\r\n`;
  const next = applyEnvBlock(source, { QQBOT_ENDPOINT: 'ws://127.0.0.1:3002' });
  assert.equal(next.split(ENV_BLOCK_START).length - 1, 1);
  assert.ok(next.includes('3002'));
  assert.ok(!next.includes('3001'), next);
});

test('withPluginInstalled：依赖与 bundles 两处一起写，且幂等', () => {
  const first = withPluginInstalled(MANIFEST, 'D:\\repo');
  assert.equal(first.changed, true);
  assert.equal(first.manifest.dependencies[PLUGIN_NAME], 'link:D:\\repo');
  assert.deepEqual(first.manifest.dsh.profile.bundles, [...MANIFEST.dsh.profile.bundles, PLUGIN_NAME]);
  // 原有的依赖 / bundle / 其它字段一个都不能少。
  assert.equal(first.manifest.dependencies['dsh-our-free-model'], '2.1.0');
  assert.equal(first.manifest.dsh.profile.bundles[0], '@deepseek-ai/dsh-base');
  assert.equal(first.manifest.private, true);
  // 原对象不许被就地改（脚本要拿它跟备份对账）。
  assert.equal(MANIFEST.dependencies[PLUGIN_NAME], undefined);
  // 幂等：再来一次什么都不改，且返回的是原对象。
  const second = withPluginInstalled(first.manifest, 'D:\\repo');
  assert.equal(second.changed, false);
  assert.equal(second.manifest, first.manifest);
});

test('withPluginInstalled：只差一半（有依赖没 bundle / 路径变了）也要能补上', () => {
  // 历史状态：装过但 bundle 被摘掉了（或 profile 是手工改的）。
  const missingBundle = { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, [PLUGIN_NAME]: 'link:D:\\repo' } };
  const repaired = withPluginInstalled(missingBundle, 'D:\\repo');
  assert.equal(repaired.changed, true);
  assert.ok(repaired.manifest.dsh.profile.bundles.includes(PLUGIN_NAME));
  // 仓库换了位置：link: 必须跟着改（否则加载的还是旧路径）。
  const moved = withPluginInstalled(repaired.manifest, 'E:\\other\\repo');
  assert.equal(moved.changed, true);
  assert.equal(moved.manifest.dependencies[PLUGIN_NAME], 'link:E:\\other\\repo');
  // 缺 dependencies / dsh / bundles 的畸形 manifest 也要能用，而不是抛错。
  const bare = withPluginInstalled({ name: 'x' }, 'D:\\repo');
  assert.equal(bare.changed, true);
  assert.deepEqual(bare.manifest.dsh.profile.bundles, [PLUGIN_NAME]);
});
