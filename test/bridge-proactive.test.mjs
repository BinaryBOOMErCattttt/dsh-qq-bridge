/**
 * 集成测试分册：主动说话（安静之后自己冒泡）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-proactive.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withinActiveHours } from '../index.js';
import { SELF_ID, turnContextText, until, privateMessage, privateMessageWithReply, groupMessage, mention, completeTurn, sentTexts, boot, settle, bootProactive, groupWhereBotSpoke, groupChatter } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


/** 主动说话的可选边界：左闭右开、两边相等 = 全天、from > to = 跨零点。 */
test('withinActiveHours is half-open, all-day when equal, and wraps midnight', () => {
  assert.equal(withinActiveHours(9, 23, 9), true);
  assert.equal(withinActiveHours(9, 23, 22), true);
  assert.equal(withinActiveHours(9, 23, 23), false, 'the end hour is exclusive');
  assert.equal(withinActiveHours(9, 23, 3), false, 'the small hours are quiet');
  assert.equal(withinActiveHours(22, 3, 23), true, 'a window may wrap midnight');
  assert.equal(withinActiveHours(22, 3, 2), true);
  assert.equal(withinActiveHours(22, 3, 3), false);
  assert.equal(withinActiveHours(22, 3, 12), false);
  assert.equal(withinActiveHours(23, 0, 23), true);
  assert.equal(withinActiveHours(0, 0, 4), true, 'from === to means all day');
});


/** 主动说话：群里安静下来之后真的冒一句，而且走的是同一条拟人通道。 */
test('proactive: the bot speaks up once a group has gone quiet, on the humanized path', async () => {
  const { onebot, host } = await bootProactive();
  const agent = await groupWhereBotSpoke(onebot, host);

  // 它刚说完、之后没人接话：这时候再自己开口就是独白（真人也不会对着空群自说自话）。
  host.list.timers.fireInterval();
  await settle(120);
  assert.equal(agent.inbox.length, 1, 'the bot must not monologue after its own reply');
  assert.equal(sentTexts(onebot).length, 1);

  // 另一个群友说了一句之后才轮到它：这一轮是插件伪造的 user message，不是谁在跟它说话。
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'a proactive turn to be submitted');
  const nudge = agent.inbox[agent.inbox.length - 1].content[0].text;
  assert.match(nudge, /不是谁发给你的消息/);
  assert.match(nudge, /SKIP/);
  assert.match(nudge, /已经安静了大约 \d+ 分钟/);
  // 群里刚说过的话在这一轮的情境里 —— 有上下文才可能接得上话。
  assert.match(turnContextText(agent), /今晚吃啥/);

  // 回复照常按「换行 = 分条」发出去，说明主动搭话用的是拟人通道而不是一条整段。
  completeTurn(host, agent, '随便点个外卖吧\n你吃啥', 2);
  await until(() => sentTexts(onebot).length === 3, 'the proactive messages to go out');
  assert.deepEqual(sentTexts(onebot).slice(1), ['随便点个外卖吧', '你吃啥']);
});


/** 主动说话：判成 SKIP 就一个字都不发，但这次机会照样用掉。 */
test('proactive: SKIP keeps the group silent yet still spends the chance', async () => {
  const { onebot, host } = await bootProactive({ proactiveGapMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'a proactive turn to be submitted');
  // 后面那半句「解释」也不该发出去：模型只是在说明自己的决定。
  completeTurn(host, agent, 'SKIP（没什么可说的）', 2);
  await settle(150);
  assert.equal(sentTexts(onebot).length, 1, 'SKIP must not be sent to the group');

  // 又一次「有人说话」把机会递到眼前：刚掷中过（虽然没说），间隔闸必须拦住 ——
  // 否则 SKIP 会变成「再来一次」，每检查一次就掷一回骰子。
  await groupChatter(onebot, '还在吗', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'a skipped nudge still counts against the gap');
  assert.equal(sentTexts(onebot).length, 1);
});


/**
 * `SKIP` 是**整个会话**的「不说了」信号，不只管主动搭话那一轮。
 *
 * 提醒落在同一个会话的上下文里，模型会在**回别人**的那一轮照样写一个 `SKIP`（真实事故：
 * 它引用了别人的表情包，正文写着 `SKIP`，群里就收到两个字面的字母）。所以「引用 + SKIP」
 * 必须一起被拦住 —— 而会「引用」的本来就只有回别人那一轮：主动搭话的 `quote` 永远是空的。
 *
 * 群聊那一条用 `replyStyle: 'quote'` 把引用**钉死在第一条**上（默认 `auto` 要等话头被挤远
 * 才引用），于是这一段正好覆盖「引用段与 SKIP 正文同时存在」的那种消息。
 */
test('a plain reply of SKIP is dropped in a quoted turn too', async () => {
  // 刻意**不**开 proactive：这是「回别人」的那条路（`owner.proactive` 没有这个标记），
  // 也正是唯一会带上引用的那条路（主动搭话的 `quote` 永远是空的）。
  const { onebot, host } = await boot(
    { proactive: false, digestCatchUp: false, digestMinLines: 9999 },
    {},
    {
      getMsg: async () => ({ sender: { nickname: 'iroha' }, message: [{ type: 'text', data: { text: '刚才那句是什么' } }] }),
    },
  );
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 引用着上一条、正文只有一个 `SKIP`：模型大概是在学着提醒里的出口，但这一轮并没有
  // 提醒，它只是「在回别人的话」。这句照样不该变成一个群友会看到的词。
  onebot.push(privateMessageWithReply('skip', '9001'));
  await until(() => agent.inbox.length >= 2, 'the quoted turn to be submitted');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1, 'a quoted SKIP must not be sent either');
});


test('a SKIP is dropped when the reply would have carried a quote segment', async () => {
  // `replyStyle: 'quote'` 把引用**钉死在第一条**上（默认 `auto` 要等话头被挤远才引用），
  // 于是这里正好是「引用段与 SKIP 正文同时存在」的那种消息。
  const { onebot, host } = await bootProactive(
    {
      replyStyle: 'quote',
      // 这组用例只关心引用；主动说话那条路（平时 `proactiveIdleMs: 0` 一定会开口）在这里
      // 要拦住，否则两次 sweep 各自开口一次，第二轮就不是我们喂进去的那条了。
      proactiveIdleMs: 24 * 60 * 60 * 1000,
    },
    {},
    { getMsg: async () => ({ sender: { card: 'kaguya' }, message: [{ type: 'text', data: { text: '你看这个' } }] }) },
  );
  const agent = await groupWhereBotSpoke(onebot, host);

  // 「@ 了它 + 引用了上一条」：@ 是触发方式，引用才是这条用例要的输入。
  onebot.push(
    groupMessage(
      [
        { type: 'reply', data: { id: '7000' } },
        { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
        { type: 'text', data: { text: '这个表情是啥' } },
      ],
      { messageId: 7002 },
    ),
  );
  await until(() => agent.inbox.length >= 2, 'the second turn to be submitted');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  // 只有第一条回复（带引用的那个）：判成 SKIP 的那一条连引用段都不该发出去。
  assert.equal(sentTexts(onebot).length, 1, 'a quoted SKIP must not be sent');
  assert.deepEqual(sentTexts(onebot)[0][0], { type: 'reply', data: { id: '7000' } });
});


/** 主动说话默认关闭：连定时器都不挂，更不会开口。 */
test('proactive is on by default: the timer is registered, and proactive: false silences it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-off-'));
  // ① 默认（开着）：除了开关，其它条件调成「一定会说」—— 它就该开口。
  const on = await boot({
    cwd,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
    // 这里要数清楚「挂着几个周期定时器」：API key 轮换默认开着、与主动说话无关。
    apiKeyRotate: false,
  });
  try {
    const agent = await groupWhereBotSpoke(on.onebot, on.host);
    await groupChatter(on.onebot);
    // 摘要 + 主动说话两个定时器都挂着。
    assert.equal(on.host.list.timers.live('intervals').length, 2, 'digest and proactive timers');
    on.host.list.timers.fireInterval();
    await until(() => agent.inbox.length >= 2, 'a proactive turn by default');
  } finally {
    await on.onebot.close();
  }

  // ② 关掉之后：只剩摘要定时器，而且永远不主动开口。
  const off = await boot({
    cwd,
    proactive: false,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
    apiKeyRotate: false,
  });
  try {
    const agent = await groupWhereBotSpoke(off.onebot, off.host);
    await groupChatter(off.onebot);
    assert.equal(off.host.list.timers.live('intervals').length, 1, 'only the daily digest timer should be registered');
    off.host.list.timers.fireInterval();
    await settle(150);
    assert.equal(agent.inbox.length, 1, 'without proactive the bot never speaks first');
    assert.equal(sentTexts(off.onebot).length, 1);
  } finally {
    await off.onebot.close();
  }
});


/** 主动说话只在群里发生：私聊对象是真人和机器人之间的对话，不该被无端戳一下。 */
test('proactive never messages a private chat', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-private-'));
  const { onebot, host } = await boot({
    cwd,
    proactive: true,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFreshMs: 0,
    proactiveGapMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the private turn');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the private reply');
  // 对方又发了一句，这一轮模型**选择不说**（正文写 `SKIP`；空回复不是「选择不说」，
  // 那种情况插件会重问一次，见 test/bridge-send.test.mjs）—— 于是这个私聊会话正好停在
  // 「最后说话的是对方」这个状态上：换成群，它就会进入主动说话的候选。
  onebot.push(privateMessage('你忙不'));
  await until(() => agent.inbox.length >= 2, 'the second private message to be submitted');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(80);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'private chats are never nudged by the plugin');
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1);
});


/** 时段闸：不在配置的「清醒时段」里就一声不吭（真人半夜不会突然冒泡）。 */
test('proactive stays inside the configured hours', async () => {
  // 挑一个必然不含当前小时的两小时窗口：+2 → +3。
  const hour = new Date().getHours();
  const { onebot, host } = await bootProactive({
    proactiveFromHour: (hour + 2) % 24,
    proactiveToHour: (hour + 3) % 24,
  });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'outside the waking hours the bot stays quiet');
});


/** 安静时长闸：群里还在聊的时候不插嘴。 */
test('proactive leaves a group alone while it is still talking', async () => {
  const { onebot, host } = await bootProactive({ proactiveIdleMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a group that just spoke is not the bot\'s turn');
});


/** 新鲜度闸：好几天没人说话的冷群不会突然诈尸。 */
test('proactive does not resurrect a group that has been quiet for too long', async () => {
  const { onebot, host } = await bootProactive({ proactiveFreshMs: 1 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a stale group should not suddenly hear from the bot');
});


/** 每日上限：同一个群一天说够了就不再开口，哪怕又有人接话。 */
test('proactive respects the daily cap per group', async () => {
  const { onebot, host } = await bootProactive({ proactiveDailyMax: 1 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the first proactive turn');
  completeTurn(host, agent, '外卖吧', 2);
  await until(() => sentTexts(onebot).length >= 2, 'the first proactive message');

  // 又有人说话、安静时长与间隔都满足，但今天这个群的额度用完了。
  await groupChatter(onebot, '你们在干嘛', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the daily cap should stop a second nudge');
});


/** 主动搭话出错时不道歉：没人问过它，平白多一句「我这边出错了」只是噪音。 */
test('a proactive turn that errors stays silent instead of apologising', async () => {
  const { onebot, host } = await bootProactive();
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the proactive turn');
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[agent.inbox.length - 1], turn: 2 });
  host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } });
  await settle(150);
  assert.equal(sentTexts(onebot).length, 1, 'nobody asked the bot anything, so it must not apologise');
});


/** `/reset` 连主动说话的节奏一起忘掉：刚清空完不该还被「两小时前主动说过」挡着。 */
test('proactive forgets its own pacing when the conversation is reset', async () => {
  const { onebot, host } = await bootProactive({ proactiveGapMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the first proactive turn');
  completeTurn(host, agent, '外卖吧', 2);
  await until(() => sentTexts(onebot).length >= 2, 'the proactive message');
  // 间隔闸生效：刚主动说完，下一句就不该再说。
  await groupChatter(onebot, '话说回来', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the gap should hold before the reset');

  // 新开一轮会话：确认消息也是一句「机器人说的话」，于是还得等群里有人接一句才轮到它。
  // 群聊的 /reset 得 @ 它（默认 groupTrigger: mention），所以这里用 mention。
  onebot.push(mention('/reset'));
  await until(() => sentTexts(onebot).some((text) => String(text).includes('已开始新会话')), 'the reset confirmation');
  await groupChatter(onebot, '那继续吧', { messageId: 7004 });
  host.list.timers.fireInterval();
  // 会话真的被重建了：旧 Agent 被销毁，主动搭话投给了新造的那个 Agent。
  const fresh = await until(() => host.list.created[1], 'a fresh Agent for the proactive turn');
  assert.equal(fresh.inbox.length, 1);
  assert.match(fresh.inbox[0].content[0].text, /不是谁发给你的消息/);
  assert.ok(host.list.disposed.length >= 1, 'the reset should have disposed the old Agent');
  assert.equal(agent.inbox.length, 2, 'the disposed Agent gets nothing more');
});
