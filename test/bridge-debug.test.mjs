/**
 * 集成测试分册：调试提权（`debug` / `overdebug`）。
 *
 * 验的是**端到端**那条路：主人私聊里发指令 → 插件备份并开放 → 工具的 `execute()`
 * 真的能读工作区外 → `overdebug` 之后立刻拒绝 → 群里 / 非主人开不了。
 * 四道闸的边界与回滚细节在 `test/debug.test.mjs`。
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GROUP_USER_ID,
  PRIVATE_USER_ID,
  boot,
  cleanupBoots,
  completeTurn,
  mention,
  privateMessage,
  sentTexts,
  settle,
  until,
  untilInbox,
} from './harness.mjs';

after(async () => { await cleanupBoots(); });

const OWNER = String(PRIVATE_USER_ID);

/** 一条出站消息的正文（字符串或 text 段都收）。 */
function textOf(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('');
}

/** 某个 action 下已发出的所有非空正文。 */
function said(onebot, action) {
  return sentTexts(onebot, action).map(textOf).filter((text) => text.length > 0);
}

function waitSaid(onebot, action, needle) {
  return until(() => said(onebot, action).find((text) => text.includes(needle)), action + ' should contain ' + needle);
}

test('debug：主人私聊开 10 分钟提权，工具真的能读工作区外；overdebug 之后立刻拒绝', async () => {
  const { onebot, host, cwd } = await boot({ debug: true, resetUsers: [OWNER] });
  try {
    // 先聊一轮，让会话的「这一轮发言人」记下来（工具权限按这一轮谁在说话判）。
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    await untilInbox(host);
    completeTurn(host, agent, '在的');
    await settle(150);

    // 工作区外的一个文件：只有提权之后才读得到。
    const outside = await mkdtemp(join(tmpdir(), 'qq-debug-outside-'));
    const secret = join(outside, 'outside.txt');
    await writeFile(secret, '工作区外的内容', 'utf8');

    const readTool = host.tools.get('qq_debug_read');
    assert.ok(readTool, 'qq_debug_read should be registered');
    // 没开 debug 之前：拒绝，而且原因说得清（不是「工具不存在」）。
    await assert.rejects(() => readTool.execute({ path: secret }, { agent }), /debug 模式没开/);

    onebot.push(privateMessage('debug'));
    const opened = await waitSaid(onebot, 'send_private_msg', '调试模式已开');
    assert.match(opened, /10 分钟/);
    // 设置备份到 data/debug/<时间>/baseline/，带一份变更日志。
    const dirs = await until(async () => {
      try {
        const list = await import('node:fs/promises').then((fs) => fs.readdir(join(cwd, 'data', 'debug')));
        return list.length > 0 ? list : undefined;
      } catch {
        return undefined;
      }
    }, 'the debug snapshot directory');
    assert.ok(existsSync(join(cwd, 'data', 'debug', dirs[0], 'baseline', 'settings.json')));
    assert.ok(existsSync(join(cwd, 'data', 'debug', dirs[0], 'CHANGELOG.md')));
    const settings = JSON.parse(await readFile(join(cwd, 'data', 'debug', dirs[0], 'baseline', 'settings.json'), 'utf8'));
    assert.equal(settings.accessToken, undefined, '凭据不许进快照');

    // 现在能读了。
    const read = await readTool.execute({ path: secret }, { agent });
    assert.equal(read.text, '工作区外的内容');
    assert.equal(read.bytes, Buffer.byteLength('工作区外的内容'));

    // 写工作区外的文件：写前自动备份，rollback 能恢复。
    const writeTool = host.tools.get('qq_debug_write');
    await writeTool.execute({ path: secret, content: '被调试改过' }, { agent });
    assert.equal(await readFile(secret, 'utf8'), '被调试改过');

    // qq_debug_log 把「改了什么」记进本次的 CHANGELOG.md。
    const logTool = host.tools.get('qq_debug_log');
    await logTool.execute({ summary: '改了外部文件', files: 'outside.txt:1' }, { agent });
    const changelog = await readFile(join(cwd, 'data', 'debug', dirs[0], 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /改了外部文件/);

    // 列目录也走同一道闸。
    const listTool = host.tools.get('qq_debug_list');
    const listed = await listTool.execute({ path: outside }, { agent });
    assert.ok(listed.entries.some((line) => line.includes('outside.txt')));

    // overdebug：立即退出，工具马上恢复拒绝。
    onebot.push(privateMessage('overdebug'));
    await waitSaid(onebot, 'send_private_msg', '调试模式已退出');
    await assert.rejects(() => readTool.execute({ path: secret }, { agent }), /debug 模式没开/);
  } finally {
    await onebot.close();
  }
});

test('debug：debug: false 时连指令都不开；群里开不了；非主人开不了', async () => {
  const off = await boot({ resetUsers: [OWNER] });
  try {
    off.onebot.push(privateMessage('debug'));
    const refused = await waitSaid(off.onebot, 'send_private_msg', 'debug 没开');
    assert.match(refused, /debug true/);
    assert.equal(off.host.tools.get('qq_debug_read') !== undefined, true, '工具仍注册（开关在 execute 里判）');
  } finally {
    await off.onebot.close();
  }

  // 群里的发言者也算主人：这样才能验「debug 只在私聊」那条，而不是先被权限挡掉。
  const on = await boot({ debug: true, resetUsers: [OWNER, String(GROUP_USER_ID)] });
  try {
    // 群里：只认主人私聊。
    on.onebot.push(mention('debug'));
    const inGroup = await waitSaid(on.onebot, 'send_group_msg', 'debug 只能在主人私聊里开');
    assert.match(inGroup, /私聊/);

    // 非主人：owner 级指令直接挡掉。
    const stranger = privateMessage('debug');
    stranger.user_id = 100000099;
    stranger.sender = { nickname: '路人' };
    on.onebot.push(stranger);
    const denied = await waitSaid(on.onebot, 'send_private_msg', '这个指令只有主人能用');
    assert.match(denied, /主人/);
  } finally {
    await on.onebot.close();
  }
});
