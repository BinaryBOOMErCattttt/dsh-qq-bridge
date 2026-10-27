/**
 * 调试提权（`debug.js`）的四道闸、TTL、审计与回滚。
 *
 * 这是整个插件里唯一能绕过 `cwd` 沙箱的通道，所以判据全部单独验：配置 / 模块 /
 * 是否开过 / 过期 / 会话对不对 / 这一轮是不是主人 —— 任何一道都不许漏。
 * 端到端（QQ 私聊里发 `debug` → 工具真的能读工作区外 → `overdebug` 之后立刻拒绝）
 * 在 `test/bridge-debug.test.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEBUG_TTL_MS, createDebugMode, debugStamp } from '../debug.js';

const OWNER = { key: 'private:100000002', type: 'private' };

/** 建一个临时工作区 + 假插件根（baseline 会去读那边的 cordis.patch.yml）。 */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-debug-cwd-'));
  const pluginRoot = await mkdtemp(join(tmpdir(), 'qq-debug-plugin-'));
  await writeFile(join(pluginRoot, 'cordis.patch.yml'), 'patched: true\n', 'utf8');
  await mkdir(join(cwd, '.qq-persona'), { recursive: true });
  await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), '旧人设\n', 'utf8');
  return { cwd, pluginRoot };
}

/**
 * 一份带假时钟的调试状态机。
 *
 * `setTimeout` 被换成立即记录：TTL 是 10 分钟，测试不能真等；到期那一刻由用例
 * 手动 `fire()`，这样「到点自关」和「到点之前都还能用」两条都能验。
 */
function harness({ settings = {}, moduleEnabled = () => true, authority = { allowed: true }, conversation = OWNER, cwd, pluginRoot }) {
  const clock = { at: 1_800_000_000_000 };
  const timers = [];
  const said = [];
  const mode = createDebugMode({
    cwd,
    pluginRoot,
    settings,
    moduleEnabled,
    conversationOfExec: () => conversation,
    writeAuthority: () => authority,
    send: (_conversation, text) => said.push(text),
    restart: () => said.push('（重启）'),
    now: () => clock.at,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer !== undefined) timer.cleared = true; },
  });
  return { mode, clock, timers, said };
}

/** 等一个异步落盘的文件出现（审计是 fire-and-forget 写的，不能立刻读）。 */
async function waitForFile(path, pattern) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    try {
      const text = await readFile(path, 'utf8');
      if (pattern.test(text)) return text;
    } catch {
      // 还没写出来
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for ' + path);
}

const exec = { agent: { id: 'agent-1' } };

test('debugStamp：Windows 非法字符（: 与 .）被换掉', () => {
  const stamp = debugStamp(Date.UTC(2026, 9, 26, 22, 9, 39, 12));
  assert.equal(stamp, '2026-10-26T22-09-39-012Z');
  assert.doesNotMatch(stamp, /[:.]/u);
});

test('guard：配置 / 模块 / 开没开 / 过期 / 会话 / 主人，六道闸逐个验', async () => {
  const { cwd, pluginRoot } = await workspace();

  // 1) debug: false（默认），连 debug 指令都只回「没开」。
  const off = harness({ settings: { debug: false }, cwd, pluginRoot });
  assert.deepEqual(off.mode.guard(exec), { allowed: false, reason: 'debug 配置没开（设置 debug true）' });
  await off.mode.start(OWNER);
  assert.match(off.said.join('\n'), /debug 没开/);
  assert.equal(off.mode.state.active, false, '配置没开时 start 不许留下任何状态');

  // 2) 模块关着（简洁模式 / moduleDebug: false）。
  const noModule = harness({ settings: { debug: true }, moduleEnabled: () => false, cwd, pluginRoot });
  assert.equal(noModule.mode.guard(exec).allowed, false);
  await noModule.mode.start(OWNER);
  assert.match(noModule.said.join('\n'), /moduleDebug/);

  // 3) 开了之后：工具放行。
  const on = harness({ settings: { debug: true }, cwd, pluginRoot });
  assert.deepEqual(on.mode.guard(exec), { allowed: false, reason: 'debug 模式没开（主人在私聊里发 debug）' });
  await on.mode.start(OWNER);
  assert.deepEqual(on.mode.guard(exec), { allowed: true });

  // 4) 到点自关：TTL 从开启时算 10 分钟。
  on.clock.at += DEBUG_TTL_MS - 1;
  assert.equal(on.mode.guard(exec).allowed, true, '差 1 毫秒都还算开着');
  on.clock.at += 1;
  assert.equal(on.mode.guard(exec).allowed, false);
  assert.match(on.mode.guard(exec).reason, /过期/);

  // 5) 只对开启它的那个会话生效。
  const other = harness({ settings: { debug: true }, cwd, pluginRoot });
  await other.mode.start(OWNER);
  const elsewhere = createDebugMode({
    cwd,
    pluginRoot,
    settings: { debug: true },
    conversationOfExec: () => ({ key: 'group:999', type: 'group' }),
    writeAuthority: () => ({ allowed: true }),
    send: () => {},
    now: () => other.clock.at,
  });
  assert.equal(elsewhere.guard(exec).allowed, false, '换一个会话实例自然就是「没开」');

  // 6) 主人当轮：writeAuthority 说不行就不行（群里混进一个群友那种）。
  const stranger = harness({ settings: { debug: true }, authority: { allowed: false, reason: '这一轮说话的人里有非主人' }, cwd, pluginRoot });
  await stranger.mode.start(OWNER);
  assert.deepEqual(stranger.mode.guard(exec), { allowed: false, reason: '这一轮说话的人里有非主人' });
});

test('start：只在主人私聊开，快照基线、去凭据、挂 10 分钟定时器、写审计', async () => {
  const { cwd, pluginRoot } = await workspace();
  const { mode, timers, said } = harness({
    settings: { debug: true, accessToken: 'tok', apiKey: 'sk-1', apiKeyRef: 'DEEPSEEK_API_KEY', cwd },
    cwd,
    pluginRoot,
  });

  // 群里开不了：调试提权只认控制通道。
  await mode.start({ key: 'group:1', type: 'group' });
  assert.match(said.join('\n'), /只能在主人私聊里开/);
  assert.equal(mode.state.active, false);

  await mode.start(OWNER);
  assert.equal(mode.state.active, true);
  assert.equal(mode.state.key, OWNER.key);
  assert.equal(mode.activeFor(OWNER), true);
  assert.equal(mode.activeFor(undefined), false);
  assert.match(said.join('\n'), /调试模式已开/);

  // 目录与文件：baseline 下有线人设 + 去掉凭据的 settings.json，根上有 CHANGELOG.md。
  const dir = mode.state.dir;
  assert.ok(existsSync(join(dir, 'baseline', 'settings.json')));
  assert.ok(existsSync(join(dir, 'baseline', 'PERSONA.md')));
  assert.ok(existsSync(join(dir, 'baseline', 'cordis.patch.yml')));
  const settings = JSON.parse(await readFile(join(dir, 'baseline', 'settings.json'), 'utf8'));
  assert.equal(settings.accessToken, undefined, 'accessToken 不许进快照');
  assert.equal(settings.apiKey, undefined);
  assert.equal(settings.apiKeyRef, undefined);
  assert.equal(settings.debug, true, '其余设置照抄');

  const changelog = await readFile(mode.state.logFile, 'utf8');
  assert.match(changelog, /# Debug 变更日志/);
  assert.match(changelog, new RegExp(OWNER.key));

  // 定时器：正好 10 分钟，只挂一个。
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, DEBUG_TTL_MS);

  // 审计：全局文件里有一行 debug_on。
  await waitForFile(join(cwd, 'data', 'debug-audit.log'), /debug_on/);

  // 已经开着时说清楚还剩多久，不重新备份。
  const before = timers.length;
  await mode.start(OWNER);
  assert.equal(timers.length, before, '重复 start 不该再挂一个定时器');
  assert.match(said.join('\n'), /debug 已经开着/);
});

test('stop：到点 / 手动 / 回滚都走同一条收尾，审计记原因', async () => {
  const { cwd, pluginRoot } = await workspace();
  const { mode, timers, said } = harness({ settings: { debug: true }, cwd, pluginRoot });
  assert.equal(mode.stop('manual'), false, '没开着时返回 false（指令据此回一句「现在不在 debug」）');

  await mode.start(OWNER);
  // 到点：定时器回调就是 stop('timeout')。
  timers[0].fn();
  assert.equal(mode.state.active, false);
  assert.match(said.join('\n'), /到点自动退出/);

  const audit = await waitForFile(join(cwd, 'data', 'debug-audit.log'), /debug_off/);
  assert.match(audit, /timeout/);
});

test('backup / rollback：按 manifest 恢复被覆盖的文件、删掉新建的文件', async () => {
  const { cwd, pluginRoot } = await workspace();
  const { mode, said } = harness({ settings: { debug: true }, cwd, pluginRoot });
  const target = join(cwd, 'notes.md');
  const fresh = join(cwd, 'brand-new.md');
  await writeFile(target, '原来的内容\n', 'utf8');
  await mode.start(OWNER);

  // 覆盖前备份，再写；新建的文件也要记账（existed: false → 回滚时删掉）。
  await mode.backup(target);
  await writeFile(target, '被改过了\n', 'utf8');
  await mode.backup(fresh);
  await writeFile(fresh, '新文件\n', 'utf8');
  // 同一个路径只备份第一次：第二次写不该把「第一次改完的样子」当成原始版本。
  await mode.backup(target);
  await writeFile(target, '又改了一次\n', 'utf8');

  assert.equal(await mode.rollback(), true);
  assert.equal(await readFile(target, 'utf8'), '原来的内容\n');
  assert.equal(existsSync(fresh), false, 'debug 期间新建的文件要删掉');
  assert.equal(mode.state.active, false, '回滚之后退出');
  assert.match(said.join('\n'), /已回滚/);
  assert.match(said.join('\n'), /（重启）/, '配置被恢复后要重启插件才生效');

  // 人设也回到基线（debug 期间改了 .qq-persona/PERSONA.md 也一样）。
  await mode.start(OWNER);
  await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), '改坏了\n', 'utf8');
  assert.equal(await mode.rollback(), true);
  assert.equal(await readFile(join(cwd, '.qq-persona', 'PERSONA.md'), 'utf8'), '旧人设\n');
});

test('log：把一轮改动追加进 CHANGELOG.md；没开着时返回 false', async () => {
  const { cwd, pluginRoot } = await workspace();
  const { mode } = harness({ settings: { debug: true }, cwd, pluginRoot });
  assert.equal(await mode.log('没开着', 'x:1'), false);

  await mode.start(OWNER);
  assert.equal(await mode.log('改了提示词槽', 'prompt.js:120-138', '还要验一遍缓存'), true);
  const changelog = await readFile(mode.state.logFile, 'utf8');
  assert.match(changelog, /改了提示词槽/);
  assert.match(changelog, /代码位置：prompt\.js:120-138/);
  assert.match(changelog, /备注：还要验一遍缓存/);
});

test('snapshot：只复制存在的那几份文件（缺了也不算失败）', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-debug-bare-'));
  const pluginRoot = await mkdtemp(join(tmpdir(), 'qq-debug-bare-plugin-'));
  const { mode } = harness({ settings: { debug: true }, cwd, pluginRoot });
  // 没有 .qq-persona、没有 patch 文件：开得起来，baseline 里只有 settings.json。
  await mode.start(OWNER);
  const entries = await readdir(join(mode.state.dir, 'baseline'));
  assert.deepEqual(entries, ['settings.json']);
  assert.ok((await stat(mode.state.logFile)).isFile());
});
