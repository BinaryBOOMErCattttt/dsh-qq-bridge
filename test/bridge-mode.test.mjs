/**
 * 端到端：运行模式（完整 / 简洁）。
 *
 * 钉住四件事：
 *   1. `模式` 指令只在私聊里说；查看不限主人，切换只有主人能切；
 *   2. 切换会**重建会话**（旧 Agent 被销毁、换新 session id），但把最近几轮上下文
 *      挂到下一轮的「本轮情境」里接上，只喂一轮；
 *   3. 简洁模式确实收窄：工具白名单、指令白名单、提示词、回复上限；
 *   4. 模式落盘在 `data/mode.json`，启动时从文件恢复。
 *
 * 夹具在 test/harness.mjs；本文件只放这一主题的用例，可单独跑：
 * node --test test/bridge-mode.test.mjs
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIVATE_USER_ID,
  SELF_ID,
  boot,
  cleanupBoots,
  completeTurn,
  groupText,
  mention,
  pokeNotice,
  privateMessage,
  promptText,
  sentTexts,
  settle,
  turnContextText,
  until,
  untilInbox,
} from './harness.mjs';

after(async () => { await cleanupBoots(); });

const OWNER = String(PRIVATE_USER_ID);

/** 简洁模式白名单里真正存在的那几个工具，让假 Host 的 restrict 不因「未知工具」退化。 */
const SIMPLE_KNOWN_TOOLS = [
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'qq_memory', 'qq_transcript', 'qq_quiet', 'qq_settings', 'qq_time', 'qq_topic',
  'qq_send_image', 'qq_send_message', 'qq_save_sticker', 'qq_remind_create',
];

/** 一条出站消息的正文（字符串或 text 段都收）。 */
function textOf(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('');
}

/** 某个 action 已发出的所有非空正文。 */
function said(onebot, action) {
  return sentTexts(onebot, action).map(textOf).filter((text) => text.length > 0);
}

/** 等到某个 action 下出现包含 needle 的一条正文，并返回它。 */
function waitSaid(onebot, action, needle) {
  return until(
    () => said(onebot, action).find((text) => text.includes(needle)),
    action + ' should contain ' + needle,
  );
}

/** 在指定 cwd 里预写一份模式文件，再启动插件（验证启动时恢复模式）。 */
async function bootWithMode(mode, config = {}, hostOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-mode-cwd-'));
  await mkdir(join(cwd, 'data'), { recursive: true });
  await writeFile(join(cwd, 'data', 'mode.json'), JSON.stringify({ mode, at: Date.now() }), 'utf8');
  return boot({ cwd, ...config }, hostOptions);
}

/** 读当前落盘的模式。 */
async function savedMode(cwd) {
  return JSON.parse(await readFile(join(cwd, 'data', 'mode.json'), 'utf8')).mode;
}

test('模式：群里访客能看当前模式（零 token），但不能切', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('模式'));
    const reply = await waitSaid(onebot, 'send_group_msg', '当前模式');
    assert.match(reply, /当前模式：完整/);
    assert.match(reply, /只有主人能切换模式/);
    assert.equal(host.list.created.length, 0, '这条指令不该建 Agent');
  } finally {
    await onebot.close();
  }
});

test('模式：私聊里访客能看，但只有主人能切', async () => {
  const { onebot, host, cwd } = await boot({ ownerAutoClaim: false, resetUsers: [] });
  try {
    onebot.push(privateMessage('模式'));
    const view = await waitSaid(onebot, 'send_private_msg', '当前模式：完整');
    assert.match(view, /可切换：完整 \/ 简洁/);
    assert.match(view, /只有主人能切换模式/);

    onebot.push(privateMessage('模式 简洁'));
    await waitSaid(onebot, 'send_private_msg', '只有主人能切换模式');
    assert.equal(await readFile(join(cwd, 'data', 'mode.json'), 'utf8').catch(() => undefined), undefined, '没切成功就不该落盘');
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
  }
});

test('模式：主人切换会重建会话、保留上下文、落盘，并收窄工具与提示词', async () => {
  const instance = await boot(
    { resetUsers: [OWNER], ownerAutoClaim: false, pokeMode: 'text', pokeCooldownMs: 0, pokeDailyMax: 0 },
    { knownTools: SIMPLE_KNOWN_TOOLS },
  );
  const { onebot, host, cwd } = instance;
  try {
    // 先聊一句，让转录里有「可保留的上下文」。
    onebot.push(privateMessage('我们上次说的展会在周六'));
    const first = await untilInbox(host);
    completeTurn(host, first, '记得的');
    await settle(200);

    onebot.push(privateMessage('模式 简洁'));
    const confirmation = await waitSaid(onebot, 'send_private_msg', '已切到简洁模式');
    assert.match(confirmation, /保留了最近 6 轮上下文/);
    assert.equal(await savedMode(cwd), 'simple', '模式要落盘，重启不丢');
    assert.ok(host.list.disposed.includes(first.id), '旧会话的 Agent 必须被销毁');

    // 用一次「戳一戳」触发下一轮：它走 userMessageFor、立即投递、不进攒批，
    // 正好用来检查「重建之后的第一个新会话带没带上旧上下文」（简洁模式的攒批是 5 秒，
    // 普通消息要等，测试没必要陪着等）。
    onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    const second = await until(() => host.list.created[1], 'the new Agent after switching mode');
    await until(() => second.inbox.length >= 1, 'the command to reach the new Agent');
    assert.notEqual(second.id, first.id, '切模式必须换一个 session id');

    const context = turnContextText(second);
    assert.match(context, /模式切换时保留了最近 6 轮/);
    assert.match(context, /我们上次说的展会在周六/, '旧上下文要接上');
    assert.match(promptText(host, 'qq-bridge:channel'), /现在是简洁模式/);
    assert.equal(
      host.list.prompts.filter((item) => item.kind === 'section' && item.name === 'qq-bridge:channel').length,
      1,
      '旧会话的提示小节必须撤掉，不能两份叠着',
    );

    const restrict = host.list.restrictions.filter((item) => item.sessionId === second.id).at(-1);
    assert.ok(restrict, '新 Agent 要重新施加白名单');
    assert.equal(restrict.filter.allow.includes('qq_send_image'), false, '简洁模式不发图');
    assert.equal(restrict.filter.allow.includes('qq_save_sticker'), false, '简洁模式不存表情');
    assert.equal(restrict.filter.allow.includes('qq_memory'), true, '记忆要留着');
    assert.equal(restrict.filter.allow.includes('qq_quiet'), true, '静默要留着');

    // 旧上下文只喂一轮：这一轮结束后，下一轮不该再看到它。
    completeTurn(host, second, '在呢', 1);
    await settle(100);
    onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    await until(() => second.inbox.length >= 2, 'the second poke on the same Agent');
    assert.doesNotMatch(turnContextText(second), /模式切换时保留了/);

    // 切回完整模式：会话再重建一次，提示词回到完整档。
    onebot.push(privateMessage('模式 完整'));
    await waitSaid(onebot, 'send_private_msg', '已切回完整模式');
    assert.equal(await savedMode(cwd), 'full');
    onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    const third = await until(() => host.list.created[2], 'the Agent after switching back');
    await until(() => third.inbox.length >= 1, 'the poke to reach the Agent');
    assert.doesNotMatch(promptText(host, 'qq-bridge:channel'), /现在是简洁模式/);
    assert.equal(
      host.list.prompts.filter((item) => item.kind === 'section' && item.name === 'qq-bridge:channel').length,
      1,
    );
  } finally {
    await onebot.close();
  }
});

test('模式：以简洁模式启动时，指令白名单与提示词都收窄', async () => {
  const instance = await bootWithMode(
    'simple',
    { resetUsers: [OWNER], ownerAutoClaim: false, pokeMode: 'text', pokeCooldownMs: 0, pokeDailyMax: 0 },
    { knownTools: SIMPLE_KNOWN_TOOLS },
  );
  const { onebot, host } = instance;
  try {
    // 先戳一下，让提示词小节真的挂到某个 Agent 上（指令本身不会建 Agent）。
    onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    await untilInbox(host);
    assert.match(promptText(host, 'qq-bridge:channel'), /现在是简洁模式/);

    onebot.push(privateMessage('帮助'));
    const blocked = await waitSaid(onebot, 'send_private_msg', '简洁模式只保留');
    assert.match(blocked, /切回完整模式/);

    // 状态仍可用，并且要报出当前模式。
    onebot.push(privateMessage('状态'));
    const status = await waitSaid(onebot, 'send_private_msg', '模式：简洁');
    assert.match(status, /连接：/);

    // 天气属于「查」，在简洁模式里直接拦掉（不能等到联网那一步）。
    onebot.push(privateMessage('天气 杭州'));
    await until(
      () => said(onebot, 'send_private_msg').filter((text) => text.includes('简洁模式只保留')).length >= 2,
      'the second blocked command',
    );
    assert.equal(said(onebot, 'send_private_msg').filter((text) => text.includes('简洁模式只保留')).length, 2);
    assert.equal(host.list.created.length, 1, '被拦下的指令不该再建新的 Agent');
  } finally {
    await onebot.close();
  }
});

test('模式：模块开关单独关掉一片指令（完整模式）', async () => {
  const instance = await boot({
    resetUsers: [OWNER],
    ownerAutoClaim: false,
    moduleFun: false,
    moduleHandoff: false,
  });
  const { onebot, host } = instance;
  try {
    onebot.push(privateMessage('抽签'));
    const funBlocked = await waitSaid(onebot, 'send_private_msg', '「fun」模块现在是关的');
    assert.match(funBlocked, /moduleFun 设成 true/);

    onebot.push(privateMessage('定档'));
    const handoffBlocked = await waitSaid(onebot, 'send_private_msg', '「handoff」模块现在是关的');
    assert.match(handoffBlocked, /moduleHandoff 设成 true/);
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
  }
});

test('模式：简洁模式回复硬上限 400 字，完整模式 800 字', async () => {
  const simple = await bootWithMode('simple', { resetUsers: [OWNER], ownerAutoClaim: false, pokeMode: 'text', pokeCooldownMs: 0, pokeDailyMax: 0 });
  try {
    simple.onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    const agent = await untilInbox(simple.host);
    completeTurn(simple.host, agent, 'x'.repeat(500));
    // 等后置条件而不是「发出第一条」：回复会被拆成好几条气泡，等到第一条就断言
    // join 的长度会读到半截（全量并发跑时机器一忙就随机红）。等 400 字全到齐。
    const replies = await until(() => {
      const all = said(simple.onebot, 'send_private_msg');
      return all.join('').length >= 400 ? all : undefined;
    }, 'the whole simple-mode reply');
    assert.equal(replies.join('').length, 400, '简洁模式截到 400 字');
  } finally {
    await simple.onebot.close();
  }

  const full = await boot({ resetUsers: [OWNER], ownerAutoClaim: false });
  try {
    full.onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(full.host);
    completeTurn(full.host, agent, 'x'.repeat(500));
    // 同上：完整模式不截断，500 字也要全发完再比长度。
    const replies = await until(() => {
      const all = said(full.onebot, 'send_private_msg');
      return all.join('').length >= 500 ? all : undefined;
    }, 'the whole full-mode reply');
    assert.equal(replies.join('').length, 500, '完整模式 500 字原样发');
  } finally {
    await full.onebot.close();
  }
});

test('模式：简洁模式不复读（同一句话连着出现也不跟）', async () => {
  const instance = await bootWithMode('simple', { repeat: true, repeatCount: 2 });
  const { onebot, host } = instance;
  try {
    onebot.push(groupText('草', { userId: 10001, messageId: 1 }));
    onebot.push(groupText('草', { userId: 10002, messageId: 2 }));
    await settle(300);
    assert.equal(said(onebot, 'send_group_msg').length, 0, '简洁模式一个字都不该多发');
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
  }
});
