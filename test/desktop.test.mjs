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
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applyEnvBlock, ENV_BLOCK_END, ENV_BLOCK_START, PLUGIN_NAME, pluginLinkState, removePluginLink, withPluginInstalled } from '../desktop.js';

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

// ---- 链接指着谁（pluginLinkState）------------------------------------------
//
// 这一组守的是一个**没有任何报错**的错装：`node_modules` 里的链接早就在了、却指着上一份发布包
// 或旧的 clone，而 manifest 那一行已经被改成新仓库路径。解析实际走链接，于是「装的是新的、
// 跑的是旧的」。所以判据不能是「链接存在不存在」，只能是「链接指着谁」。

const LINK_PATH = 'C:\\Users\\me\\.dsh\\profiles\\desktop\\node_modules\\@qqbot\\dsh-plugin-qq';

/** 造一份假的 `node:fs` 子集：`stat` 说那里是什么（缺省 = 什么都没，即 ENOENT）。 */
function fakeFs({ stat, native, plain, link } = {}) {
  return {
    lstatSync: () => {
      if (stat === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return stat;
    },
    // 真的 `realpathSync` 上挂着 `.native`（Windows 上只有它跟得动 junction），假的一样挂。
    realpathSync: Object.assign(
      () => {
        if (plain === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        return plain;
      },
      { native: () => { if (native === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); return native; } },
    ),
    readlinkSync: () => {
      if (link === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return link;
    },
  };
}

const DIRECTORY = { isSymbolicLink: () => false, isDirectory: () => true };
const SYMLINK = { isSymbolicLink: () => true, isDirectory: () => false };
const FILE = { isSymbolicLink: () => false, isDirectory: () => false };

test('pluginLinkState：链接指着本仓库时才算装对了（盘符大小写与斜杠方向不算差别）', () => {
  const same = pluginLinkState(LINK_PATH, 'd:/repo', fakeFs({ stat: SYMLINK, native: 'D:\\repo\\' }));
  assert.equal(same.state, 'linked');
  // 反方向也要认：目标写的是小写盘符、正斜杠。
  assert.equal(pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs({ stat: DIRECTORY, native: 'd:/REPO' })).state, 'linked');
});

test('pluginLinkState：链接指着别处时必须是 elsewhere（这正是「装了不生效」的那种状态）', () => {
  // 实测现场：链接指着 dev 仓库，而 manifest 已经改成发布包目录。
  const stale = pluginLinkState(LINK_PATH, 'D:\\temp\\dsh-qq-bridge-0.1.1', fakeFs({ stat: DIRECTORY, native: 'D:\\.my_projects\\dsh-qq-bridge' }));
  assert.equal(stale.state, 'elsewhere');
  assert.equal(stale.target.replace(/\\/g, '/').toLowerCase(), 'd:/.my_projects/dsh-qq-bridge');
});

test('pluginLinkState：native 拿不到答案就退回普通 realpath / readlink，全拿不到才是 unknown', () => {
  // Windows junction 只有 `realpathSync.native` 跟得动；普通版把链接自己当结果返回 ——
  // 那必须判成「指着别处」，否则脚本会以为配好了，继续用旧代码。
  const selfReturned = pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs({ stat: DIRECTORY, plain: LINK_PATH }));
  assert.equal(selfReturned.state, 'elsewhere');
  // 链接的目标被删过（realpath 全失败）时，POSIX 上 `readlink` 还答得出来（相对目标原样返回）。
  const viaReadlink = pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs({ stat: SYMLINK, link: '../../repo' }));
  assert.equal(viaReadlink.state, 'elsewhere');
  assert.equal(viaReadlink.target, '../../repo');
  // 三条路都没有答案：交给调用方（脚本会重建链接）。
  assert.equal(pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs({ stat: DIRECTORY })).state, 'unknown');
});

test('pluginLinkState：不存在 = missing，普通文件 = not-a-link（后者不许当链接删）', () => {
  assert.deepEqual(pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs()), { state: 'missing', target: undefined });
  // 那里有个真的普通文件：删它是破坏性动作，必须单独一种状态。
  assert.equal(pluginLinkState(LINK_PATH, 'D:\\repo', fakeFs({ stat: FILE, native: 'D:\\repo' })).state, 'not-a-link');
  // 空值也不能炸（脚本里 linkPath 永远是拼出来的，这里守的是纯函数的边界）。
  assert.equal(pluginLinkState(LINK_PATH, undefined, fakeFs({ stat: DIRECTORY, native: 'D:\\repo' })).state, 'elsewhere');
});

// 真文件系统那一条：上面那份假 fs 是按「我们以为 Node 怎么答」写的，而 Windows 上的 junction
// 正是这次踩坑的地方（`readlinkSync` 对 reparse point 一律 `EINVAL`）。所以真的建一条链接验一遍，
// 建不了（非 Windows / 没权限）就跳过 —— 这条用例的价值在于钉住「谁跟得动 junction」这件事。
test('pluginLinkState：真建一条 junction，必须认得出它指着哪（Windows 上只有 native realpath 跟得动）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqbridge-link-'));
  try {
    const target = join(root, 'repo');
    const linkPath = join(root, 'node_modules', '@qqbot', 'dsh-plugin-qq');
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('这个环境建不了链接（Windows 上需要权限或开发者模式）');
      return;
    }
    const state = pluginLinkState(linkPath, target, fs);
    assert.equal(state.state, 'linked', `实际读到的指向：${state.target}`);
    // 指向变了（例如换了仓库位置）必须立刻判出来 —— 用户就是这样踩到「装了新包跑旧代码」的。
    assert.equal(pluginLinkState(linkPath, join(root, 'other'), fs).state, 'elsewhere');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removePluginLink：真建一条 junction 并删掉它 —— 链接消失、目标里的文件一个都不能少', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qqbridge-rmlink-'));
  try {
    const target = join(root, 'repo');
    const linkPath = join(root, 'node_modules', '@qqbot', 'dsh-plugin-qq');
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    writeFileSync(join(target, 'index.js'), '// 插件的源码');
    try {
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('这个环境建不了链接（Windows 上需要权限或开发者模式）');
      return;
    }
    // `fs.unlink` 对 junction 是 EPERM（实测），所以先 unlink 再 rmdir 这条顺序必须保住。
    assert.equal(removePluginLink(linkPath, fs), true);
    assert.equal(existsSync(linkPath), false, '链接本身必须没了');
    assert.equal(readFileSync(join(target, 'index.js'), 'utf8'), '// 插件的源码', '目标目录里的文件绝不能被删');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removePluginLink：两条路都失败时返回 false（不抛错 —— 调用方要拿它去说一句人话）', () => {
  const boom = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.equal(removePluginLink('D:\\whatever', { unlinkSync: boom, rmdirSync: boom }), false);
  // 只有 unlink 失败也要退到 rmdir（junction 正是这一种）。
  assert.equal(removePluginLink('D:\\whatever', { unlinkSync: boom, rmdirSync: () => {} }), true);
});
