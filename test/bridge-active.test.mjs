/**
 * 集成测试分册：活跃对话（免 @ 接话 / 多人搭话 / 补一句 / 插话）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-active.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, liveConfig } from '../index.js';
import { mentionsOthers } from '../onebot.js';
import { SELF_ID, until, untilInbox, privateMessage, groupMessage, mention, completeTurn, sentTexts, boot, groupText, settle, bootActive, talkRollConfig, bootHotGroup } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


/** `mentionsOthers` 只认指向**别人**的 at 段（`at all` 也算别人，空 qq 不算）。 */
test('mentionsOthers sees at-segments aimed at somebody else', () => {
  const at = (qq) => ({ type: 'at', data: { qq } });
  const text = (value) => ({ type: 'text', data: { text: value } });
  assert.equal(mentionsOthers([text('你好')], SELF_ID), false);
  assert.equal(mentionsOthers([at(SELF_ID), text('你好')], SELF_ID), false);
  assert.equal(mentionsOthers([at('10001'), text('你看')], SELF_ID), true);
  assert.equal(mentionsOthers([at('all'), text('大家看')], SELF_ID), true);
  assert.equal(mentionsOthers([at(''), text('空')], SELF_ID), false);
  assert.equal(mentionsOthers('纯字符串没有段', SELF_ID), false);
});


/** 活跃对话窗口里的空消息不算「接话」：那只是「他说了句话，正好没内容」，不能抢答。 */
test('a blank message inside the active window does not count as a follow-up', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着发一个空格：窗口虽然热，但这句没有点它，不算接话。
  onebot.push(groupText('   ', { messageId: 7001 }));
  await settle(120);
  assert.equal(agent.inbox.length, 1, '空白的「接话」不该被当成在跟它说话');
});


/** A：跟它聊的那个人接着说的话，不用再 @ 一次。 */
test('activeFollow: the person it was talking to can keep talking without another @', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着说，没有 @：窗口里算「接着聊」。
  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up to be admitted without a mention');
  assert.equal(agent.inbox[1].content[0].text, '那你说呢');

  // 别人插一句不算：他没在跟它聊（闲聊也不该因此进 Agent）。
  onebot.push(groupText('我先走了', { messageId: 7002, userId: 10001, card: 'soyo' }));
  await settle(60);
  assert.equal(agent.inbox.length, 2, 'a different person is not part of the exchange');
});


/** A：默认关闭 —— 它放松的是「群里只在被 @ 时才说话」这条默认约定。 */
test('activeFollow is on by default, and turning it off restores the @ requirement', async () => {
  // ① 默认（开着）：被叫到之后的窗口里，同一个人接着说的话不必再 @（抽卡概率调成 1）。
  const on = await mkdtemp(join(tmpdir(), 'qq-bridge-active-on-'));
  const followed = await boot({ cwd: on, digestCatchUp: false, digestMinLines: 9999, activeTalkChance: 1 });
  try {
    followed.onebot.push(mention('在吗'));
    const agent = await until(() => followed.host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
    completeTurn(followed.host, agent, '在的', 1);
    await until(() => sentTexts(followed.onebot).length === 1, 'the reply to go out');
    followed.onebot.push(groupText('那你说呢', { messageId: 7001 }));
    await until(() => agent.inbox.length >= 2, 'the follow-up to be accepted by default');
  } finally {
    await followed.onebot.close();
  }

  // ② 关掉之后：群里仍然只在被 @ 时说话。
  const off = await mkdtemp(join(tmpdir(), 'qq-bridge-active-off-'));
  const { onebot, host } = await boot({ cwd: off, digestCatchUp: false, digestMinLines: 9999, activeFollow: false });
  try {
    onebot.push(mention('在吗'));
    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
    completeTurn(host, agent, '在的', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupText('那你说呢', { messageId: 7001 }));
    await settle(80);
    assert.equal(agent.inbox.length, 1, 'without activeFollow the @ requirement still holds');
  } finally {
    await onebot.close();
  }
});


/** A：中间有别人说话，这次「你跟我聊」就算断了。 */
test('activeFollow: a third party speaking in between ends the exchange', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('你们聊', { messageId: 7001, userId: 10001, card: 'soyo' }));
  await settle(60);
  onebot.push(groupText('那你说呢', { messageId: 7002 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'the exchange is over once someone else speaks');
});


/** A：@ 别人（或 @ 全体）的那句不是跟它说的。 */
test('activeFollow: a message that mentions somebody else is not a follow-up', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupMessage([
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: '你怎么看' } },
  ], { messageId: 7001 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'a message aimed at somebody else must be left alone');
});


/** A：一次活跃对话里免 @ 接的轮数有上限（`activeMaxTurns`）。 */
test('activeFollow: activeMaxTurns limits how long it keeps following', async () => {
  const { onebot, host } = await bootActive({ activeMaxTurns: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the first follow-up');
  completeTurn(host, agent, '我觉得行', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  onebot.push(groupText('还有呢', { messageId: 7002 }));
  await settle(80);
  assert.equal(agent.inbox.length, 2, 'the cap should force a fresh mention');
});


/** A：两条消息之间隔太久，这段一对一的「还聊着」就断了，得重新 @ 它。 */
test('activeFollow: the one-to-one window expires when the person goes quiet', async () => {
  // 断聊间隔 1 毫秒：下一条消息到的时候必然已经过期 —— 不依赖用例跑多久。
  const { onebot, host } = await bootActive({ activeFollowIdleMs: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'an expired window means a mention is needed again');
});


/** A：窗口跟着「最后被叫到的那个人」走。 */
test('activeFollow: the window follows whoever spoke to it last', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the first mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 另一个群友（soyo）也 @ 它：窗口换到 soyo 身上。
  onebot.push(mention('我也问一句', { userId: 10001, card: 'soyo', messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the second mention');
  completeTurn(host, agent, '你说', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  onebot.push(groupText('那然后呢', { messageId: 7002, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 3, 'the new speaker may continue');
  // 最早那个人回来了，但他已经不在窗口里。
  onebot.push(groupText('（我问的）', { messageId: 7003 }));
  await settle(80);
  assert.equal(agent.inbox.length, 3, 'only the latest speaker is inside the window');
});


/** A：前缀模式下接上的那句不能按前缀长度硬切（「然后呢」不该变成「后呢」）。 */
test('activeFollow: a followed message keeps its text intact in prefix mode', async () => {
  const { onebot, host } = await bootActive({ groupTrigger: 'prefix' });
  onebot.push(groupText('/你好'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the prefixed message');
  assert.equal(agent.inbox[0].content[0].text, '你好');
  completeTurn(host, agent, '你好呀', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('然后呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up');
  assert.equal(agent.inbox[1].content[0].text, '然后呢');
});


/** B：它回完之后对方安静一小会儿，它可能再补一句 —— 私聊也可以。 */
test('activeChime: it adds one more line into the lull after its reply', async () => {
  // 私聊走 L2（`privateAfterthought*`），不再借群聊那套 activeChime 参数。
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // 私聊里没有 @ 这回事：回完之后对方安静下来，它自己再投一条「补一句」的提醒。
  await until(() => agent.inbox.length >= 2, 'the follow-up turn to be submitted');
  const nudge = agent.inbox[1].content[0].text;
  assert.match(nudge, /你已经回过话/);
  assert.match(nudge, /SKIP/);
  // 投放它的时候没有在跟谁说话，所以不挂引用。
  completeTurn(host, agent, '对了，你上次说的那个展去了吗', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up to go out');
  assert.equal(sentTexts(onebot, 'send_private_msg')[1], '对了，你上次说的那个展去了吗');

  // 不会连珠炮：对方每说一句之后最多补一句。
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the bot must not keep talking into the void');
});


/** B：判成 SKIP 就一个字都不发。 */
test('activeChime: a SKIP keeps the lull silent', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  await until(() => agent.inbox.length >= 2, 'the follow-up turn');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1, 'SKIP must not be sent');
});


/** B：群聊的补一句仍然需要 `proactive` 这个总开关（它是「允许主动发消息」的开关）。 */
test('activeChime in a group needs the proactive master switch', async () => {
  const { onebot, host } = await bootActive({ activeChimeIdleMs: 30 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await settle(200);
  assert.equal(agent.inbox.length, 1, 'without proactive a group is not chimed into');
});


/** L2：私聊补一句**不**搭 `proactive` 那趟车 —— 它默认就是开的（§6.5 的语义例外）。 */
test('the private afterthought is on by default and does not need proactive', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 30, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // proactive 关着（bootActive 默认不打开），私聊照样会补一句。
  await until(() => agent.inbox.length >= 2, 'the private follow-up turn');
  assert.match(agent.inbox[1].content[0].text, /你已经回过话/);
  assert.match(agent.inbox[1].content[0].text, /SKIP/);
  completeTurn(host, agent, '对了，你昨天说的那个事后来怎么样了', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up to go out');
});


/** L2：空消息（只是一个空格 / 单纯 @）之后的轮次不补 —— 那一轮本来就没有话题。 */
test('a reply to an empty private message does not schedule an afterthought', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 20, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('   '));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the empty message');
  completeTurn(host, agent, '？', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'an empty message is not a topic to add to');
});


/** L2：出错的那一轮不补一句（没人问过它，也别在事后追一句）。 */
test('an errored private turn does not schedule an afterthought', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 20, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the private Agent');
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
  host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } });
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the error notice');
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'no afterthought after an error');
});


/** B：群里中间有人插话时不要硬补一句（那会儿话头已经不是它的了）。 */
test('activeChime: somebody else speaking first keeps the bot from chiming in', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 40 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 它正准备补一句的时候，群里别人先说话了 → 不插嘴。
  onebot.push(groupText('那我先撤了', { messageId: 7001, userId: 10001, card: 'soyo' }));
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'a third party breaks the lull');
});


/** B：群里没人插话时，补一句照常发生（用户能看见的那条通路）。 */
test('activeChime: in a group it adds its line when nobody else speaks', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 40 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await until(() => agent.inbox.length >= 2, 'the follow-up turn to be submitted');
  assert.match(agent.inbox[1].content[0].text, /你已经回过话/);
  completeTurn(host, agent, '对了，你昨天那个事怎么样了', 2);
  await until(() => sentTexts(onebot).length === 2, 'the follow-up to go out');
  assert.equal(sentTexts(onebot)[1], '对了，你昨天那个事怎么样了');
});


/** B：对方再说话会把挂着的「补一句」作废（一条消息只对应一次机会）。 */
test('activeChime: a new message from the other side cancels the pending follow-up', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 60,
    privateAfterthoughtChance: 1,
  });
  onebot.push(privateMessage('第一句'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '回第一句', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 补一句的定时器还没醒（60 毫秒），对方又说话了：那个定时器作废，只按新消息再排一个。
  onebot.push(privateMessage('第二句'));
  await until(() => agent.inbox.length >= 2, 'the second message');
  completeTurn(host, agent, '回第二句', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the second reply');

  await until(() => agent.inbox.length >= 3, 'exactly one follow-up turn');
  await settle(200);
  assert.equal(agent.inbox.length, 3, 'the stale timer must not add a second follow-up');
});


/** B：单会话每天的补一句额度用完了就不再补。 */
test('activeChime: activeChimeDailyMax caps the day', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
    privateAfterthoughtDailyMax: 1,
  });
  onebot.push(privateMessage('第一句'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '回第一句', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 第一次补一句用掉了当天的额度。
  await until(() => agent.inbox.length >= 2, 'the first follow-up turn');
  completeTurn(host, agent, '补的第一句', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up');

  // 对方又说话、它又回：这一轮不该再补。
  onebot.push(privateMessage('第三句'));
  await until(() => agent.inbox.length >= 3, 'the third message');
  completeTurn(host, agent, '回第三句', 3);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 3, 'the third reply');
  await settle(200);
  assert.equal(agent.inbox.length, 3, 'the daily chime budget is spent');
});


/** `/reset` 会把「还聊着」也忘掉：新开一轮之后不会再补一句。 */
test('/reset forgets the active exchange as well', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 40,
    privateAfterthoughtChance: 1,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // 补一句还没醒就 /reset：窗口与定时器一起没了。
  onebot.push(privateMessage('/reset'));
  await until(() => sentTexts(onebot, 'send_private_msg').some((text) => String(text).includes('已开始新会话')), 'the reset confirmation');
  await settle(200);
  // 补一句若真的醒了，它会开一轮新 turn —— 那必然要新建一个 Agent（旧的刚被销毁）。
  // 所以「没有第二个 Agent」就是「那个定时器确实被作废了」的最强证据。
  assert.equal(host.list.created.length, 1, 'the cancelled chime must not open a turn after the reset');
});


/** 活跃对话里接上的一句只是闲聊，不是指令：`/reset` 得明确叫它才算。 */
test('activeFollow: a followed message never triggers a command bypass', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 窗口内同一句话没有 @：它被当成闲聊交给 Agent，而不是当作 /reset 执行。
  onebot.push(groupText('/reset', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the followed message to reach the Agent');
  assert.equal(agent.inbox[1].content[0].text, '/reset');
  await settle(80);
  assert.ok(!sentTexts(onebot).some((text) => String(text).includes('已开始新会话')), 'the window must not run commands');
});


// ---- 多人搭话：群里几个人自己聊热了，它插进去接着聊 ---------------------------------------

/** 多人搭话的默认值：1 分钟窗口、6 条、2 个人、倾听时间 ×2。 */
test('group talk defaults: a 1-minute window, 6 lines from 2 speakers, listening doubled', () => {
  assert.equal(liveConfig(Config({})).activeWindowMs, 60 * 1000);
  assert.equal(liveConfig(Config({})).activeGroupLines, 6);
  assert.equal(liveConfig(Config({})).activeGroupSpeakers, 2);
  assert.equal(liveConfig(Config({})).activeGroupBatchScale, 2);
});


/**
 * 一对一的免 @ 接话用**自己**的断聊间隔（`activeFollowIdleMs`，默认 3 分钟），不是
 * `activeWindowMs` 那 1 分钟 —— 后者现在只管「补一句」与多人搭话的热度。两个窗口分开是
 * 刻意的：把 60 秒拉长到 3 分钟会让群更容易被判成聊热（更多插话），而一对一需要的只是
 * 「两条消息之间别太远」。
 */
test('the one-to-one window is activeFollowIdleMs, not the chime/heat window', async () => {
  // 默认 3 分钟：@ 一次买的是这一段，不是「这一整天它都归你了」。
  assert.equal(liveConfig(Config({})).activeFollowIdleMs, 3 * 60 * 1000);
  assert.equal(liveConfig(Config({})).activeWindowMs, 60 * 1000);

  // 把断聊间隔压到 1 毫秒：下一条必然已经出窗，@ 要求就回来了。
  const { onebot, host } = await bootActive({ activeFollowIdleMs: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await settle(30);
  onebot.push(groupText('那你说呢', { messageId: 7051 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'once the window is over the @ requirement is back');
});


/** 群里几个人聊够条数之后，谁接话都不用再 @ 它 —— 这就是多人搭话。 */
test('group talk: once a few people have been chatting, anyone can talk without a mention', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 4, activeGroupSpeakers: 2 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 别人插话：一对一窗口认的是被 @ 的那个人，所以这两句都不该进去；但它们记进了
  // 「这个群最近聊了几句、几个人」，也就是搭话状态的门槛。
  onebot.push(groupText('这个我也想知道', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('+1', { messageId: 7102, userId: 10002, card: 'rana' }));
  await settle(60);
  assert.equal(agent.inbox.length, 1, 'below the threshold a stranger is still not part of the exchange');

  // 第 4 句（@ 的那条 + 这 3 条）踩到门槛：从这一条起群聊算「热起来了」，谁接话都算。
  onebot.push(groupText('那到底行不行', { messageId: 7103, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the group talk message to reach the Agent');
  // 插话（C 路）的投递文案是**元信息 + 锚点 + SKIP 出口**（§7.2）：不写清「这句不是叫你的」，
  // 模型会按「回答 soyo」组织语言，群里看到的就是答非所问。
  const interject = agent.inbox[1].content[0].text;
  assert.match(interject, /群里在聊天，这句不是叫你的/);
  assert.match(interject, /soyo 说：那到底行不行/);
  assert.match(interject, /SKIP/);

  // 门槛过了之后，换一个人、甚至同一个人再说，都还在搭话状态里。
  onebot.push(groupText('我觉得行', { messageId: 7104, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 3, 'another speaker to be admitted as well');
});


/** 人多才算「聊起来了」：同一个人自己刷屏，条数再多也不进搭话状态。 */
test('group talk: one person talking a lot is not a conversation', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 3, activeGroupSpeakers: 3 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 同一个人连发 6 句：条数远超 3，但说过话的只有「@ 它的那位」和「这个人」两个人，
  // 不够 activeGroupSpeakers: 3。
  for (let i = 0; i < 6; i += 1) {
    onebot.push(groupText(`第 ${i} 句`, { messageId: 7200 + i, userId: 10001, card: 'soyo' }));
  }
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'a single person spamming must not open group talk');
});


/** 搭话状态里「倾听时间」变长：攒批窗口与整批上限一起放大，多听几句再合成一轮。 */
test('group talk: it listens longer before answering', async () => {
  const { onebot, host } = await bootActive({
    batchWindowMs: 80,
    batchMaxWaitMs: 200,
    activeGroupLines: 4,
    activeGroupSpeakers: 2,
    activeGroupBatchScale: 6,
  });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('这家伙谁啊', { messageId: 7301, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('不知道', { messageId: 7302, userId: 10002, card: 'rana' }));
  // 第 4 句（@ 的那条 + 这 3 条）踩到门槛：这一条起攒批窗口从 80ms 变成 80×6 = 480ms。
  onebot.push(groupText('问问他', { messageId: 7303, userId: 10001, card: 'soyo' }));
  // 200ms 早就超过不放大时的 80ms，但还不到放大后的 480ms —— 说明它还在听。
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'in group talk it keeps listening instead of cutting a batch short');
  await until(() => agent.inbox.length >= 2, 'the longer batch to flush eventually');
});


/** 多人搭话也在 `activeFollow` 这道总闸门后面：默认关着，群里照旧只在被 @ 时说话。 */
test('group talk needs activeFollow: turning it off keeps the mention requirement', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-talk-default-'));
  // 多人搭话跟着 `activeFollow` 这个总闸走；默认开，所以这里显式关掉再验「不接」。
  const { onebot, host } = await boot({
    cwd,
    digestCatchUp: false,
    digestMinLines: 9999,
    activeFollow: false,
    activeGroupLines: 2,
    activeGroupSpeakers: 2,
  });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('甲', { messageId: 7401, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7402, userId: 10002, card: 'rana' }));
  onebot.push(groupText('丙', { messageId: 7403, userId: 10001, card: 'soyo' }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'with activeFollow off the group talk gate stays shut');
});


/** `/reset` 也把「大家正聊着」的那个窗口忘掉：新一轮不该接着上一轮的群聊热度。 */
test('/reset forgets the group talk window as well', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 3, activeGroupSpeakers: 2 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the first Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 别人插一句：此刻窗口里是「@ 的那条 + 这一条」= 2 条，还差一条到门槛。
  onebot.push(groupText('插一句', { messageId: 7501, userId: 10001, card: 'soyo' }));
  await settle(40);
  // 明确 @ 它发 /reset：这条自己会把窗口顶到 3 条，正因为如此才要看 /reset 有没有清掉它。
  onebot.push(mention('/reset', { messageId: 7502 }));
  await until(
    () => sentTexts(onebot).some((text) => String(text).includes('已开始新会话')),
    'the reset confirmation',
  );
  await until(() => host.list.disposed.length >= 1, 'the old Agent to be disposed');

  // 若窗口没被清掉，这一条就是第 4 条（够条数、够人数），会开一个新 Agent 去接；
  // 「没有第二个 Agent」就是「群聊热度确实忘了」的证据。
  onebot.push(groupText('还在吗', { messageId: 7503, userId: 10001, card: 'soyo' }));
  await settle(80);
  assert.equal(host.list.created.length, 1, 'the old heat must not carry into the new round');
});


test('A 路不抽卡：抽卡参数全设成 0 也照回（一对一里那个人的每条都回）', async () => {
  // `activeTalkChance: 0` + step 1：如果 A 路还抽卡，第一句就必然不接。
  const { onebot, host } = await bootActive(talkRollConfig());
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着说的三句：一句都不能少（这就是「@ 一次之后能连着聊」）。
  for (const [index, text] of ['那你说呢', '到底行不行', '还有吗'].entries()) {
    onebot.push(groupText(text, { messageId: 7601 + index }));
    await until(() => agent.inbox.length >= index + 2, `follow-up #${index + 1} to be admitted`);
    assert.equal(agent.inbox[index + 1].content[0].text, text);
    completeTurn(host, agent, `回 ${index + 1}`, index + 2);
    await until(() => sentTexts(onebot).length >= index + 2, `reply #${index + 1} to go out`);
  }
});


test('A 路：插话（多人搭话）不顺手买一段一对一 —— 被接话的人不会接着白拿免 @', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲让热度到 2（还不够），乙踩到门槛（3 条）→ 够资格但概率 0，不接。
  onebot.push(groupText('甲', { messageId: 7631, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7632, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '搭话状态里概率 0 也不接');

  // 连丢一条之后概率涨到 1：丙这一句被接住（C 路插话）。
  onebot.push(groupText('丙', { messageId: 7633, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the next group-talk message to hit the roll');
  assert.match(agent.inbox[1].content[0].text, /soyo 说：丙/);
  completeTurn(host, agent, '嗯', 2);
  await until(() => sentTexts(onebot).length === 2, 'the interjection to go out');

  // 插话不买一对一：soyo 再说话仍然要走 C 路，而概率已经归零 → 不接。
  onebot.push(groupText('丁', { messageId: 7634, userId: 10001, card: 'soyo' }));
  await settle(100);
  assert.equal(agent.inbox.length, 2, '插话之后不留下一个一对一窗口');
});


test('多人搭话：被明确 @ 到就直接回，并把连丢的累计清零', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲让热度到 2，乙踩到门槛（3 条）→ 够资格但概率 0，先连丢一条。
  onebot.push(groupText('甲', { messageId: 7621, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7622, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '先连丢一条');

  // 被 @ 到：不抽卡，直接回；累计也该清零（它刚说过话）。
  onebot.push(mention('那这个呢', { messageId: 7623 }));
  await until(() => agent.inbox.length >= 2, 'the explicit mention to be admitted');
  completeTurn(host, agent, '这个啊', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  // 群里还热着，但第三次够资格的概率必须回到起始的 0（若保底留着，这里会是 1 = 必中）。
  onebot.push(groupText('丙', { messageId: 7624, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 2, '被 @ 到之后累计清零：这一条又回到起始概率 0');
});


test('搭话抽卡：多人搭话里也不是每条都回，攒够概率才接', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲这一句让热度到 2，还差一条；乙那一句踩到门槛（3 条）—— 它就是够资格的那条，
  // 概率 0 → 不接。
  onebot.push(groupText('甲', { messageId: 7631, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7632, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '搭话状态里概率 0 也不接');

  // 连丢一条之后概率涨到 1：换一个人接话也算（C 路「谁接话都算数」）。
  onebot.push(groupText('丙', { messageId: 7633, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the next group-talk message to hit the roll');
  assert.match(agent.inbox[1].content[0].text, /soyo 说：丙/);
});


test('搭话抽卡：这段对话凉了之后累计清零，不把保底留到下一场聊天', async () => {
  const { onebot, host } = await bootActive(
    talkRollConfig({ activeWindowMs: 400, activeGroupLines: 3, activeGroupSpeakers: 2 }),
  );
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 顶到门槛（3 条）并连丢一条：甲让热度到 2，乙踩到门槛 → 够资格但概率 0，不接。
  onebot.push(groupText('甲', { messageId: 7641, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7642, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '这一条没抽中');

  // 等热度窗口彻底凉掉（activeWindowMs = 400ms）：这段对话结束，累计也该忘掉。
  await settle(500);

  // 重新凑一场：前两条还不够热（这时「不够资格」就该把累计清掉），第三条够资格时
  // 概率必须回到起始的 0；若保底留着，这里会是 1（必中），断言就会红。
  onebot.push(groupText('丁', { messageId: 7644, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('戊', { messageId: 7645, userId: 10002, card: 'rana' }));
  onebot.push(groupText('己', { messageId: 7646, userId: 10001, card: 'soyo' }));
  await settle(150);
  assert.equal(agent.inbox.length, 1, '凉过之后回到起始概率，保底不跨对话');
});


test('插话轮不再强制引用锚点：紧挨着回时按 replyStyle: auto 走裸文本', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  // 两个不同的人把热度顶过门槛（第 4 句才够热），第三句是那条被接的锚点。
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('随便', { messageId: 7102, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 2, 'the interject turn');
  const interject = agent.inbox[1].content[0].text;
  assert.match(interject, /这句不是叫你的/);
  assert.match(interject, /rana 说：随便/);

  completeTurn(host, agent, '火锅吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the interject reply');
  // 插话不挂指向：它不是在「回某一条」，而是顺着气氛自己凑一句（见 `quoteHead` 第 0 条）。
  // 紧挨着回时本来就该是裸文本 —— 以前那条「插话必须引用锚点」的规矩连同
  // `interjectQuote` 一起删了。
  assert.equal(sent, '火锅吧');
});


test('插话轮不挂引用：replyStyle: quote 也只发裸文本', async () => {
  // `replyStyle` 是「回别人的时候怎么指向」的配置，插话不是回答，不该被它钉上一个引用块。
  const { onebot, host, agent } = await bootHotGroup({ replyStyle: 'quote' });
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('随便', { messageId: 7102, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 2, 'the interject turn');
  completeTurn(host, agent, '火锅吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the interject reply');
  assert.equal(sent, '火锅吧', '搭话不是「回某一条」，引用块会让人觉得是在处理工单');
});


test('免 @ 接话也不挂指向：replyStyle: at 的那一轮只发裸文本', async () => {
  // A 路（窗口里接上的一句）与 C 路（插话）同一口径：都是它自己凑上来的，不点名。
  const { onebot, host } = await bootActive({ replyStyle: 'at' });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up without a mention');
  completeTurn(host, agent, '就这样吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the follow-up reply');
  assert.equal(sent, '就这样吧', '免 @ 接话不是回提问者，不该再 @ 一次');
});


test('插话不接 @ 了别人的消息（那是别人在跟别人说话）', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  // 这一条 @ 的是 rana，不是机器人：热度早就够了，但它不该被当成「可以插一句」。
  onebot.push(groupMessage(
    [{ type: 'at', data: { qq: '10002', name: 'rana' } }, { type: 'text', data: { text: ' 你看这个' } }],
    { messageId: 7102, userId: 10001, card: 'soyo' },
  ));
  await settle(120);
  assert.equal(agent.inbox.length, 1, 'a message meant for somebody else is not an invitation');
});


test('插话不接命令，也不接纯媒体（没有可接的话头）', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  // 命令：即使群里正热，`/reset` 也不该被「插话」顺手执行（更不该进模型）。
  onebot.push(groupText('/reset', { messageId: 7102, userId: 10001, card: 'soyo' }));
  // 纯媒体：正文只有 `[图片]` 这个占位符，没有文字锚点。
  onebot.push(groupMessage([{ type: 'image', data: { file: 'x.png', url: '' } }], { messageId: 7103, userId: 10002, card: 'rana' }));
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a command and a media-only message are not interjected into');
});
