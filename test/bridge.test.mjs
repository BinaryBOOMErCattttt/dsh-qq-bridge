/**
 * 集成测试分册：核心（入站 / 准入 / 攒批 / 会话 / 工具 / 预设 / 提示词 / 环境）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Config, apply, liveConfig, sessionIdFor } from '../index.js';
import { blankMessageLabel } from '../onebot.js';
import { SESSION_ROUTE_PATH } from '../util.js';
import { DEFAULT_ALLOW_TOOLS, SELF_ID, PRIVATE_USER_ID, GROUP_USER_ID, promptText, turnContextText, until, untilInbox, privateMessage, groupMessage, mention, completeTurn, sentTexts, boot, groupText, settle } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


// 用例一：私聊消息 → Agent turn → 回复回到 QQ。
test('a private message becomes an Agent turn whose reply returns to QQ', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'text', data: { text: '你好' } }],
    });

    // 等到消息真的投进 Agent 的收件箱（理由见 untilInbox）。
    const agent = await untilInbox(host, 1, 'the private message to reach the Agent');
    assert.deepEqual(agent.options, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
    assert.equal(agent.inbox.length, 1);
    assert.equal(agent.inbox[0].content[0].text, '你好');
    assert.equal(agent.inbox[0].role, 'user');
    assert.equal(agent.inbox[0].source.kind, 'user');

    // QQ 渠道提示小节必须注册在该 Agent 自己的作用域上。
    assert.ok(host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel'));
    const modelVariable = host.list.prompts.find((entry) => entry.kind === 'variable' && entry.name === 'model');
    assert.equal(modelVariable.provider(), 'deepseek-flash');

    // 下面模拟 Harness：认领这条消息（开启 turn），再产出最终的 assistant 消息。
    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先看看' }, { type: 'text', text: '你好呀，很高兴认识你' }] } },
    });
    // 不属于本插件的会话事件绝不能被转发出去（防止串台）。
    host.list.emit('session/event', { id: 'some-other-session' }, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'unrelated' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    const sent = await until(
      () => (sentTexts(onebot, 'send_private_msg').length === 2 ? sentTexts(onebot, 'send_private_msg') : undefined),
      'the reply to reach QQ',
    );
    assert.equal(onebot.calls.find((call) => call.action === 'send_private_msg').params.user_id, '100000002');
    // 多条 assistant 文本在同一个 turn 内累积（用换行连接）；humanize 下换行 = 分条，
    // 所以这是两条独立的消息，而不是一条消息里换行。
    assert.deepEqual(sent, ['我先看看', '你好呀，很高兴认识你']);
  } finally {
    await onebot.close();
  }
});


// 用例：私聊里从「模型开始想怎么回」到「消息真的发出去」之间，对方能看到「正在输入」。
// 群聊不做这件事（人多时的噪音远大于收益），而且这个动作是协议端扩展：失败绝不能拖累发送。
test('私聊会点亮「正在输入」，并在这一轮结束时清掉', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the private message');
    const session = { id: agent.id };
    // 认领 = 模型开始想怎么回：输入状态在这一刻点亮，而不是等第一条字打出来。
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
    const typing = await until(
      () => onebot.calls.find((call) => call.action === 'set_input_status' && call.params.event_type === 1),
      'the typing status while the model is thinking',
    );
    assert.equal(typing.params.user_id, '100000002');

    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    // 这一轮结束时先撤掉输入状态；真要发的那条会在发送前再点亮一次（见 sendParts）。
    assert.ok(
      onebot.calls.some((call) => call.action === 'set_input_status' && call.params.event_type === 0),
      'the typing status should be cleared after the turn',
    );
  } finally {
    await onebot.close();
  }
});


// 用例：关掉 `privateTyping` 就一条输入状态都不发（协议端不支持时也能用这个开关彻底安静）。
test('privateTyping=false 时不发输入状态', async () => {
  const { onebot, host } = await boot({ privateTyping: false });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the private message');
    completeTurn(host, agent, '在的');
    await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    assert.equal(onebot.calls.some((call) => call.action === 'set_input_status'), false);
  } finally {
    await onebot.close();
  }
});


// 用例：群聊不点亮「正在输入」—— 那里人多，亮这个只是噪音。
test('群聊不发输入状态', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗'));
    const agent = await untilInbox(host, 1, 'the group message');
    completeTurn(host, agent, '在的');
    await until(() => sentTexts(onebot, 'send_group_msg')[0], 'the group reply');
    assert.equal(onebot.calls.some((call) => call.action === 'set_input_status'), false);
  } finally {
    await onebot.close();
  }
});



//
// 真实事故：19:48 那次 resume 正好赶在服务可见之前，旧代码拿不到服务就静默 return，
// 于是这个 Agent 带着**裸系统提示词**一直跑到下次重启：人设与表达规则全丢，群里的回复
// 又退化成「才没有 是你没跟上我」这种空格断句（而 STYLE.md 明明写着不许）。重启能修好，
// 但没人知道要重启 —— 所以这里钉的是「不重启也能自愈」。
test('the channel prompt is retried on the next message when systemPrompt is not ready yet', async () => {
  // 把 setup 里的三次尝试（0ms / 50ms / 200ms）全部打空，模拟服务一直不可见。
  const { onebot, host } = await boot({}, { promptSetupFailures: 3 });
  try {
    onebot.push(privateMessage('你好'));
    await untilInbox(host, 1, 'the first message to reach the Agent');
    // 第一轮服务不可见：没有渠道小节，但必须留下一条 warn（否则这次丢失永远没人发现）。
    const hasSection = () => host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel');
    assert.equal(hasSection(), false, '第一轮拿不到服务时确实挂不上');
    assert.ok(
      host.list.warnings.some((line) => line.includes('systemPrompt') && line.includes('channel prompt')),
      '服务不可见要留 warn，不能静默跳过',
    );

    // 第二条消息复用同一个 Agent（走 ensureAgent 的热路径），这一次服务已经可见：
    // 渠道小节（连同 {{model}} / {{provider}} 变量）必须补挂回来。
    onebot.push(privateMessage('还在吗'));
    await until(hasSection, 'the channel prompt to be re-attached on the next message');
    assert.equal(promptText(host, 'qq-bridge:channel').includes('不许拿空格当标点'), true, '补挂的是完整那一节');
    assert.equal(host.list.prompts.find((entry) => entry.kind === 'variable' && entry.name === 'model').provider(), 'deepseek-flash');
  } finally {
    await onebot.close();
  }
});


// 用例：竞态只晚一拍时（第一次 get 失败、50ms 后服务出现），setup 里的重试要当场把它接住 ——
// 第一条回复就不该落在「没有渠道提示词」的状态。
test('the channel prompt waits out a one-tick systemPrompt race inside setup', async () => {
  const { onebot, host } = await boot({}, { promptSetupFailures: 1 });
  try {
    onebot.push(privateMessage('你好'));
    await untilInbox(host, 1, 'the first message to reach the Agent');
    assert.equal(
      host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel'),
      true,
      '第一次 get 失败后要重试到服务出现',
    );
    assert.equal(
      host.list.warnings.some((line) => line.includes('systemPrompt') && line.includes('channel prompt')),
      false,
      '重试成功时不该报「整轮缺提示词」的 warn',
    );
  } finally {
    await onebot.close();
  }
});


// 用例二：群消息只有在 @ 机器人时才会送到 Agent。
test('a group message only reaches the Agent when the bot is mentioned', async () => {
  const { onebot, host } = await boot();
  const group = (segments) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: 100000001,
    user_id: 100000003,
    sender: { nickname: 'tomori', card: 'kaguya' },
    message: segments,
  });
  try {
    // 没有 @ 时，消息应被完全忽略（不创建任何会话）。
    onebot.push(group([{ type: 'text', data: { text: '随便聊聊' } }]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.list.created.length, 0);

    // `@bot你好` 必须只去掉 @ 段，而不能连带吃掉后面的问候语。
    onebot.push(group([{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'text', data: { text: '你好' } }]));
    // 与上面那条私聊用例同一个道理：群里这条路上还要登记发言人、解环境上下文，
    // 所以等到消息真的进了收件箱再断言（理由见 untilInbox）。
    const agent = await untilInbox(host, 1, 'the group message to reach the Agent');
    assert.equal(agent.inbox[0].content[0].text, '你好');
    // 渠道提示里应带上群号，让 Agent 知道自己在哪个群说话。
    assert.ok(promptText(host, 'qq-bridge:channel').includes('100000001'));

    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    // 群聊走 send_group_msg，且带的是 group_id。
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the group reply');
    assert.equal(sent.params.group_id, '100000001');
    assert.equal(sent.params.message, '在的');
  } finally {
    await onebot.close();
  }
});


// ---- 空消息（单纯的 @ / 一个空格）-----------------------------------------------------
//
// 这一组的前提是「没有正文不等于没有说话」：`@bot` 一下、或者私聊发一个空格，都是明确
// 点了它却又什么都没写。旧行为是 `admit` 直接丢掉，现在照常投给模型、只在正文位置放一句
// 说明，由它看着上下文决定回「？」、发张表情还是接上一句（`blankReply: false` 可关回旧行为）。

/** 空消息的替身文案是模块级纯函数，先钉住三种情形的措辞。 */
test('blankMessageLabel：群里被 @ / 群里没被 @ / 私聊，三种情形分开说', () => {
  assert.equal(blankMessageLabel({ group: true, mentionedMe: true }), '（@了你一下，没有说别的）');
  assert.equal(blankMessageLabel({ group: true, mentionedMe: false }), '（一条空消息，没有正文）');
  assert.equal(blankMessageLabel({ group: false }), '（对方发来一条空消息，什么都没写）');
  // 缺省/非法入参按「私聊的普通空消息」处理，不能抛错也不能给出空串（那等于没兜住）。
  assert.equal(blankMessageLabel(), '（对方发来一条空消息，什么都没写）');
  assert.equal(blankMessageLabel({ group: true }), '（一条空消息，没有正文）');
});


/** 群里单纯 @ 一下：照常开一轮，模型看到的是「@ 了你一下，没有说别的」。 */
test('a bare @ still reaches the Agent with a note instead of being dropped', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention(''));
    const agent = await untilInbox(host, 1, 'the bare mention to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（@了你一下，没有说别的）');

    // 一轮正常的回复照常发得出去（模型回个「？」是最自然的反应）。
    completeTurn(host, agent, '？', 1);
    assert.equal(await until(() => sentTexts(onebot)[0], 'the reply to a bare mention'), '？');
  } finally {
    await onebot.close();
  }
});


/** 只有空白字符（或者只有 @ + 空格）同样算空消息：`trim` 之后什么都不剩。 */
test('whitespace-only group messages count as blank, and groupTrigger: all says so plainly', async () => {
  const { onebot, host } = await boot({ groupTrigger: 'all' });
  try {
    // `all` 模式没有 @ 这回事，替身不该说「@ 了你一下」。
    onebot.push(groupText('   '));
    const agent = await untilInbox(host, 1, 'the blank message to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（一条空消息，没有正文）');
  } finally {
    await onebot.close();
  }
});


/** 私聊发一个空格：以前静默丢弃，现在交给模型（私聊的措辞与群聊不同）。 */
test('a whitespace-only private message is answered instead of ignored', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('  '));
    const agent = await untilInbox(host, 1, 'the blank private message to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（对方发来一条空消息，什么都没写）');

    completeTurn(host, agent, '？', 1);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    assert.equal(sent, '？');
  } finally {
    await onebot.close();
  }
});


/** `blankReply: false` 回到旧行为：空消息一律静默丢弃，连会话都不建。 */
test('blankReply: false restores dropping messages that have no text', async () => {
  const { onebot, host } = await boot({ blankReply: false });
  try {
    onebot.push(mention(''));
    onebot.push(privateMessage('   '));
    await settle(150);
    assert.equal(host.list.created.length, 0, '空消息不该建会话');
    assert.deepEqual(sentTexts(onebot), []);
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), []);
  } finally {
    await onebot.close();
  }
});


/** 空消息不能被当成指令：单纯的 `@bot` 永远只走模型，不触发任何旁路。 */
test('a bare @ reaches the model instead of a command bypass', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention(''));
    const agent = await untilInbox(host, 1, 'the bare mention to create the Agent');
    await settle(60);
    assert.equal(agent.inbox[0].content[0].text, '（@了你一下，没有说别的）');
    // 旁路会直接回一句「用法：…」；这里既没有那条回复，也没有任何 send_*。
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});


// 用例：群里几个人几乎同时 @ 机器人 —— 攒成一条 user message，只回一轮。
test('mentions that land together become one turn instead of one reply each', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400 });
  try {
    onebot.push(mention('你俩在吗', { userId: 100000003, name: 'tomori', card: 'kaguya', messageId: 7001 }));
    onebot.push(mention('帮我看看这个', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 7002 }));
    onebot.push(mention('我也想问', { userId: 4444444444, name: 'mutsumi', card: 'mutsumi', messageId: 7003 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    // 三句话 = 一条消息 = 一次 followup = 一轮 = 一条回复。
    assert.equal(agent.inbox.length, 1);
    const text = agent.inbox[0].content[0].text;
    assert.ok(text.includes('kaguya: 你俩在吗'), text);
    assert.ok(text.includes('iroha: 帮我看看这个'), text);
    assert.ok(text.includes('mutsumi: 我也想问'), text);

    // 提示词里说的是「几个人一起在跟你说话」，而不是只报最后一个。
    // 名字**不带 QQ 号**：号码印在提示词里，模型就会照着念出来（那正是不该发生的事），
    // 而它想 @ 谁时写的是 `[[@昵称]]`（见 mention.js / 下面那组用例）。
    const context = turnContextText(agent);
    assert.ok(context.includes('几乎同时在跟你说话的是：kaguya、iroha、mutsumi'), context);
    assert.ok(!context.includes('100000003'), context);
    assert.ok(!context.includes('4444444444'), context);

    completeTurn(host, agent, '都在呢', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the single reply');
    assert.equal(sent, '都在呢');
    // 再等一会儿：三个人不该被分别答复一遍。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(sentTexts(onebot), ['都在呢']);
  } finally {
    await onebot.close();
  }
});


// 用例：同一个人连发几句也只回一轮，而且指向他最后那条。
test('a run of messages from one person is one turn that quotes the last of them', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 7101 }));
    onebot.push(mention('帮我看看这个报错', { messageId: 7102 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    assert.equal(agent.inbox.length, 1);
    assert.ok(agent.inbox[0].content[0].text.includes('连着发的'), agent.inbox[0].content[0].text);

    completeTurn(host, agent, '嗯', 1);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the reply');
    assert.deepEqual(sent.params.message, [
      { type: 'reply', data: { id: '7102' } },
      { type: 'text', data: { text: '嗯' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例：一批里有好几个人时，回复不指向其中任何一个人 —— 引用谁都像是在单独回他。
test('a batch from several people is not pinned to any one of them', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { userId: 100000003, messageId: 7201 }));
    onebot.push(mention('帮我看看这个', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 7202 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    completeTurn(host, agent, '都在呢', 1);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the reply');
    assert.equal(sent.params.message, '都在呢');
  } finally {
    await onebot.close();
  }
});


// 用例：batchWindowMs: 0 回到「来一条回一条」。
test('batchWindowMs: 0 goes back to one turn per message', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 0 });
  try {
    onebot.push(mention('第一句', { messageId: 7301 }));
    onebot.push(mention('第二句', { messageId: 7302 }));
    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length === 2, 'both messages to reach the Agent separately');
    assert.equal(agent.inbox[0].content[0].text, '第一句');
    assert.equal(agent.inbox[1].content[0].text, '第二句');
  } finally {
    await onebot.close();
  }
});


// 用例：群里一直有人 @ 也不能让机器人永远不吭声 —— 一批的等待以第一条为起点卡上限。
test('the batch wait is capped even while people keep talking', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 300, batchMaxWaitMs: 600 });
  let chatter;
  try {
    const started = Date.now();
    // 不 await：一边不停地有人说话，一边看它会不会按上限把这一批发出去。
    // 没有上限的话，要等最后一句之后再过一整个窗口才轮到机器人开口（≈ 1500ms）。
    chatter = (async () => {
      for (let i = 0; i < 12; i += 1) {
        onebot.push(mention(`第 ${i} 句`, { messageId: 7400 + i }));
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();
    const agent = await until(() => host.list.created[0], 'the capped batch to flush', 3000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `the batch should flush at the cap (~600ms), took ${elapsed}ms`);
    await until(() => agent.inbox.length > 0, 'the batched messages to reach the Agent');
    assert.ok(agent.inbox.length < 12, `the batch must not wait for the chatter to stop (${agent.inbox.length} messages)`);
  } finally {
    await chatter?.catch(() => {});
    await onebot.close();
  }
});


// 长任务期间来的 @ 不排成 N 轮、N 条回复：先攒着，忙完当作「一波迟到的消息」只接一轮。
test('mentions that arrive during a long turn become one backlog wave', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 80, batchMaxWaitMs: 150, batchBacklogHoldMs: 30000, replyStyle: 'auto' });
  try {
    onebot.push(mention('第一句', { messageId: 7501 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    // 第一句开了一轮，但**不结束**：模拟一个还在跑的长任务（turn/end 一直不来）。
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7502, userId: 3333333333, name: 'iroha', card: 'iroha' }));
    onebot.push(mention('第三句', { messageId: 7503 }));
    onebot.push(mention('第四句', { messageId: 7504 }));

    // 早就超过攒批窗口与上限了，但它在忙 —— 一条都不该进收件箱。
    await settle(400);
    assert.equal(agent.inbox.length, 1, 'while the turn is running, the backlog must stay out of the inbox');

    // 长任务结束：这一波作为**一条**消息投进来。
    host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await until(() => (agent.inbox.length === 2 ? agent.inbox[1] : undefined), 'the backlog wave to reach the Agent');
    const wave = agent.inbox[1].content[0].text;
    assert.match(wave, /^（你刚才在忙别的事，/, wave);
    assert.match(wave, /iroha（(刚刚|\d+ 秒前)）: 第二句/, wave);
    assert.ok(wave.includes('第三句') && wave.includes('第四句'), wave);
    assert.ok(wave.includes('就只写 SKIP'), wave);
    // 场景提示词也得说清「你刚才在忙」，不能再写「几乎同时在跟你说话」。
    const context = turnContextText(agent);
    assert.ok(context.includes('你刚才在忙别的事'), context);
    assert.ok(!context.includes('几乎同时在跟你说话'), context);

    // 接完这一波：只发裸文本（不引用几分钟前的那一条），整波共用一轮。
    completeTurn(host, agent, '刚在忙，我看看', 2);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the backlog reply');
    assert.equal(sent.params.message, '刚在忙，我看看');
    await settle(200);
    assert.equal(agent.inbox.length, 2, 'the whole backlog must be answered in one turn');
  } finally {
    await onebot.close();
  }
});


// 憋的上限：长任务一直不结束也不能让这些消息永远投不出去（退回「排队等它忙完」）。
test('the backlog hold gives up after batchBacklogHoldMs', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 80, batchMaxWaitMs: 150, batchBacklogHoldMs: 50 });
  try {
    onebot.push(mention('第一句', { messageId: 7601 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7602 }));
    // 过了 50ms 的上限就直接投进队列（仍然是积压文案，但不再等它空闲）。
    const queued = await until(
      () => (agent.inbox.length >= 2 ? agent.inbox[1].content[0].text : undefined),
      'the overdue backlog to be queued anyway',
      3000,
    );
    assert.ok(queued.includes('第二句'), queued);
    assert.match(queued, /^（你刚才在忙别的事，/, queued);
  } finally {
    await onebot.close();
  }
});


// 关掉这一项 = 回到「每 batchMaxWaitMs 一批排队」的老行为。
test('batchBacklog: false keeps queueing one batch at a time', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 60, batchMaxWaitMs: 120, batchBacklog: false });
  try {
    onebot.push(mention('第一句', { messageId: 7701 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7702 }));
    const queued = await until(
      () => (agent.inbox.length >= 2 ? agent.inbox[1].content[0].text : undefined),
      'the second batch to be queued as before',
      3000,
    );
    // 老行为：普通批次（单个条目不包装），不是「刚才在忙」那一波。
    assert.equal(queued, '第二句');
  } finally {
    await onebot.close();
  }
});


// 用例：/reset 之前攒着的那批话要先投出去 —— 它们是重置前说的，不能被新一轮忘掉。
test('the reset command delivers a pending batch before it starts the next round', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 200, batchMaxWaitMs: 400, resetUsers: [String(PRIVATE_USER_ID)] });
  try {
    onebot.push(privateMessage('你好'));
    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');
    // 攒着的那条消息在开始新一轮之前投了出去，Agent 随后才被销毁。
    const first = host.list.created[0];
    assert.ok(first, 'the pending batch should reach the Agent before the reset');
    assert.equal(first.inbox[0].content[0].text, '你好');
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
  } finally {
    await onebot.close();
  }
});


// 用例：设置页的「重置对话」按钮 —— 列出本次运行处理过的会话，并按与 `/reset`
// 完全相同的一套给其中一个（或全部）换一轮。
test('the settings page can list conversations and start a new round', async () => {
  const routes = [];
  const connection = {
    fetch: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  const { onebot, host } = await boot({}, { connection });
  try {
    onebot.push(privateMessage('你好'));
    const first = await untilInbox(host, 1, 'the private message to reach the Agent');

    const route = routes.find((candidate) => candidate.path === SESSION_ROUTE_PATH);
    assert.ok(route, '设置页必须挂上会话列表 / 重置路由');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');

    const listResponse = await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`));
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(listResponse.headers.get('cache-control'), 'no-store');
    const listed = await listResponse.json();
    assert.equal(listed.ok, true);
    assert.equal(listed.conversations.length, 1);
    const [session] = listed.conversations;
    assert.equal(session.key, 'private:100000002');
    assert.equal(session.type, 'private');
    assert.equal(session.name, 'iroha');
    assert.equal(session.round, 0);
    assert.equal(session.sessionId, first.id, '列表里的 session id 与当前这一轮一致');
    assert.equal(Object.hasOwn(session, 'agent'), false, '内部句柄不随路由泄漏');

    const resetResponse = await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'private:100000002' }),
    }));
    assert.equal(resetResponse.status, 200);
    const result = await resetResponse.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.reset.map((entry) => entry.round), [1]);
    assert.notEqual(result.reset[0].sessionId, first.id);
    assert.equal(result.conversations[0].round, 1);
    assert.ok(host.list.disposed.includes(first.id), '旧 Agent 必须被销毁，否则下一条消息又会 resume 回来');

    // 下一条消息投进新一轮：新 Agent 的 id 就是路由刚返回的那个。
    onebot.push(privateMessage('又见面了'));
    const second = await until(
      () => (host.list.created[1]?.inbox.length >= 1 ? host.list.created[1] : undefined),
      'the next message to reach the new round',
    );
    assert.equal(second.id, result.reset[0].sessionId);
    assert.notEqual(second.id, first.id);

    // 「全部重置」走同一个动作，只是遍历会话表。
    const allResponse = await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }));
    assert.equal(allResponse.status, 200);
    const all = await allResponse.json();
    assert.equal(all.ok, true);
    assert.deepEqual(all.reset.map((entry) => entry.round), [2]);

    // 两个失败入口都要有明确的 HTTP 语义，页面才能说清楚发生了什么。
    const unknown = await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'group:999999999' }),
    }));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown-conversation');
    const missing = await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'missing-key');
  } finally {
    await onebot.close();
  }
});


// 用例：真宿主里 Connection 是在插件 apply 之后才 provide 的 —— 重置对话的路由
// 也必须靠 ctx.inject 等它出现，否则设置页那一块只会拿到 404。
test('the conversation route mounts when Connection arrives late', async () => {
  const routes = [];
  const { onebot, host } = await boot({});
  try {
    assert.equal(routes.length, 0, '服务还没出现时不该凭空挂一条路由');
    host.list.provide('connection', {
      fetch: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    });
    const route = routes.find((candidate) => candidate.path === SESSION_ROUTE_PATH);
    assert.ok(route, 'Connection 晚到时也必须补挂重置对话路由');
    const body = await (await route.fetch(new Request(`http://127.0.0.1${SESSION_ROUTE_PATH}`))).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.conversations, []);
  } finally {
    await onebot.close();
  }
});


// 用例：攒批窗口的默认值是可以直接用的「人味」节奏，也可以关掉。
// （配置 schema 是根 volatile，`Config()` 解析出来的是引用，读值要先摊平 —— 见 util.js 的 liveConfig。）
test('the batch window defaults to a human beat and can be turned off', () => {
  assert.equal(liveConfig(Config({})).batchWindowMs, 2000);
  assert.equal(liveConfig(Config({})).batchMaxWaitMs, 5000);
  assert.equal(liveConfig(Config({ batchWindowMs: 0 })).batchWindowMs, 0);
});


// 用例：配置在 Web UI 里保存之后走的是 Loader 的「volatile 热更新」路径 —— 它就地换掉
// 引用里的值、**不重跑 apply()**。插件的连接、定时器、工具注册、目录校验全在 apply 里
// 装配，所以它必须自己重启一次（`ctx.fiber.restart()`），否则界面上改了配置毫无反应。
test('配置热更新（volatile-update）之后插件重启自己，同一拍里只重启一次', async () => {
  const fiber = {
    restarts: 0,
    restart() {
      this.restarts += 1;
      return Promise.resolve();
    },
  };
  const { host } = await boot({}, { fiber });

  assert.equal(fiber.restarts, 0, '启动时不该重启');

  // 一次保存可能报出多个字段：事件是每条路径一次，但只该重启一次。
  host.list.emit('loader/volatile-update', [['repeatChance']]);
  host.list.emit('loader/volatile-update', [['proactiveChance']]);
  await until(() => fiber.restarts === 1, '热更新之后插件重启自己');
  await settle(60);
  assert.equal(fiber.restarts, 1, '一拍里只重启一次（重启本身会重跑 apply、重建监听）');
  assert.ok(
    host.list.infos.some((line) => line.includes('配置已更新')),
    '重启必须留下一条日志，否则线上排查「改了没生效」时无从下手',
  );
});


test('没有 fiber 的组合里配置热更新只记一条 warn，不假装配置生效了', async () => {
  const { host } = await boot();

  host.list.emit('loader/volatile-update', [[]]);
  await settle(20);
  assert.ok(
    host.list.warnings.some((line) => line.includes('fiber.restart')),
    '拿不到 fiber 时要说明「这份配置要重启进程才生效」',
  );
});


// 用例三：白名单、未开启的渠道、以及消息发送者是机器人自己 —— 都应被丢弃。
test('whitelists, disabled channels, and self-messages are dropped', async () => {
  const { onebot, host } = await boot({ allowUsers: ['111'], privateChat: false });
  try {
    // 私聊已被 privateChat: false 关闭，且该用户也不在白名单里，应被丢弃。
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'text', data: { text: '你好' } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
  }
});


// 用例四：模型路由 —— 配置显式指定时用配置，否则继承部署默认选择。
test('the QQ agent model is configurable and defaults to the deployment selection', async () => {
  const { onebot, host } = await boot({ provider: 'custom', model: 'my-model' });
  try {
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000003,
      sender: { nickname: 'tomori' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    });
    const agent = await until(() => host.list.created[0], 'the Agent to be created');
    // provider/model 都配置了，因此不继承默认的 reasoningEffort。
    assert.deepEqual(agent.options, { provider: 'custom', model: 'my-model' });
  } finally {
    await onebot.close();
  }
});


// 用例五：出站工具能把消息发到指定群，并在返回值里回显目标。
test('the outbound tool sends to a group and reports the target', async () => {
  const { onebot, host } = await boot();
  try {
    const tool = host.tools.get('qq_send_message');
    const value = await tool.execute({ target_type: 'group', target_id: '100000001', message: '大家好' }, {});
    assert.deepEqual(value, { target_type: 'group', target_id: '100000001', parts: 1 });
    const sent = onebot.calls.find((call) => call.action === 'send_group_msg');
    assert.equal(sent.params.message, '大家好');
  } finally {
    await onebot.close();
  }
});


// 用例六：超长回复按配置的上限自动分段（这里把上限压到 20 字符便于验证）。
test('a long reply is split at the configured limit', async () => {
  const { onebot, host } = await boot({ maxReplyChars: 20 });
  try {
    const tool = host.tools.get('qq_send_message');
    // 三段各 15 字符 + 空格分隔，总长超过 20，必然被切成 3 段。
    const text = `${'a'.repeat(15)} ${'b'.repeat(15)} ${'c'.repeat(15)}`;
    const value = await tool.execute({ target_type: 'private', target_id: '100000002', message: text }, {});
    assert.equal(value.parts, 3);
    const sent = onebot.calls.filter((call) => call.action === 'send_private_msg');
    assert.equal(sent.length, 3);
    // 每段都不能超过上限。
    assert.ok(sent.every((call) => call.params.message.length <= 20));
  } finally {
    await onebot.close();
  }
});


// 用例八：allowTools 把 QQ 会话 Agent 收窄到白名单内；留空（显式 []）则完全不限制。
test('allowTools restricts the QQ agent to the configured tools', async () => {
  // 默认值就是那 14 个（只读文件 + 检索 + 联网 + 七个 qq_*），每个 Agent 都要被收窄。
  const byDefault = await boot({}, { knownTools: DEFAULT_ALLOW_TOOLS });
  try {
    byDefault.onebot.push(privateMessage('你好'));
    const agent = await until(() => byDefault.host.list.created[0], 'the default-restricted Agent');
    assert.deepEqual(byDefault.host.list.restrictions, [
      { sessionId: agent.id, filter: { allow: DEFAULT_ALLOW_TOOLS } },
    ]);
    // 默认收窄里没有 shell：QQ 消息是不可信输入。
    assert.ok(!DEFAULT_ALLOW_TOOLS.includes('bash'));
    assert.ok(!DEFAULT_ALLOW_TOOLS.includes('write'));
  } finally {
    await byDefault.onebot.close();
  }

  // 显式留空 = 不施加任何限制（与未引入该配置时的行为一致）。
  const plain = await boot({ allowTools: [] });
  try {
    plain.onebot.push(privateMessage('你好'));
    await until(() => plain.host.list.created[0], 'the unrestricted Agent');
    assert.deepEqual(plain.host.list.restrictions, []);
    const section = promptText(plain.host, 'qq-bridge:channel');
    assert.ok(section.includes('qq_send_message / qq_list_conversations'));
  } finally {
    await plain.onebot.close();
  }

  // 非空：只放开列出的工具，且收窄发生在该 Agent 自己的作用域上。
  const restricted = await boot({ allowTools: ['read', 'qq_send_message'] });
  try {
    restricted.onebot.push(privateMessage('你好'));
    // 收窄发生在 setup 里（created 之前），但下面的「消息照常投递」读的是 inbox：
    // 只等 created[0] 会抢在 followup 之前。等收件箱里真的有那条消息。
    const agent = await untilInbox(restricted.host, 1, 'the restricted Agent');
    assert.deepEqual(restricted.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: ['read', 'qq_send_message'] } }]);
    // 消息照常投递：收窄工具不影响对话链路本身。
    assert.equal(agent.inbox.length, 1);
    // 没被放开的 qq_list_conversations 不能再出现在渠道提示里。
    const section = promptText(restricted.host, 'qq-bridge:channel');
    assert.ok(section.includes('qq_send_message'));
    assert.ok(!section.includes('qq_list_conversations'));
  } finally {
    await restricted.onebot.close();
  }
});


// 用例九：白名单里写了不存在的工具名时退化处理 —— 丢掉不认识的名字并告警；
// 一个都不剩时把工具全部收走（fail-closed），而不是让整条回复链路失效。
test('unknown names in allowTools degrade instead of breaking the conversation', async () => {
  const partial = await boot({ allowTools: ['read', 'no_such_tool'] });
  try {
    partial.onebot.push(privateMessage('你好'));
    const agent = await until(() => partial.host.list.created[0], 'the Agent');
    assert.deepEqual(partial.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: ['read'] } }]);
    assert.ok(partial.host.list.warnings.some((line) => line.includes('no_such_tool')));
  } finally {
    await partial.onebot.close();
  }

  // 全部写错：等价于禁止一切工具，但会话本身仍然活着（能收消息）。
  const broken = await boot({ allowTools: ['nope_a', 'nope_b'] });
  try {
    broken.onebot.push(privateMessage('你好'));
    // 断言的「会话本身仍然活着（能收消息）」就是收件箱：等后置条件，别等 created。
    const agent = await untilInbox(broken.host, 1, 'the Agent');
    assert.deepEqual(broken.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: [] } }]);
    assert.equal(agent.inbox.length, 1);
  } finally {
    await broken.onebot.close();
  }
});


// 用例十二：Web 表面（dsh-web-app）把 bash / fs / web 这些「agent 平面」的工具从
// 宿主搬进了 Agent 预设。插件必须让 QQ Agent join 一个预设，否则白名单里的
// read / web_search 全是「不存在的工具」—— 表现就是「QQ 会话没有联网能力」。
test('the QQ agent joins an agent preset, so preset-plane tools exist for the whitelist', async () => {
  const presets = {
    default: 'standard',
    compositions: {
      standard: ['bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'],
    },
  };
  const allowTools = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'qq_send_message', 'qq_list_conversations'];

  // 默认 `agentPreset: 'qq'` 指向本 bundle 的预设；这条用例验的是「留空 = 部署的默认预设」
  // 那条路，所以显式写空串。
  const { onebot, host, cwd } = await boot({ agentPreset: '', allowTools }, { presets });
  try {
    onebot.push(privateMessage('帮我查一下今天的新闻'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    // 加入的是部署的默认预设，并且写进了会话 header 的 agentPreset。
    assert.deepEqual(host.list.mountedPresets, ['standard']);
    assert.deepEqual(host.list.metas, [{ sessionId: agent.id, meta: { cwd, agentPreset: 'standard' } }]);
    // 预设里的工具 join 之后才存在，白名单因此**完整**生效，而不是退化成「只剩 qq_*」。
    assert.deepEqual(host.list.restrictions, [{ sessionId: agent.id, filter: { allow: allowTools } }]);
    assert.equal(
      host.list.warnings.some((line) => line.includes('allowTools rejected')),
      false,
    );
  } finally {
    await onebot.close();
  }

  // 对照组：没有预设平面时（headless 组合就是这样），同样的白名单只能留住
  // 宿主平面真实存在的工具 —— 这正是线上「没有联网能力」的成因。
  const bare = await boot({ allowTools }, { knownTools: ['qq_send_message', 'qq_list_conversations'] });
  try {
    bare.onebot.push(privateMessage('帮我查一下今天的新闻'));
    const agent = await until(() => bare.host.list.created[0], 'the Agent');
    assert.deepEqual(bare.host.list.mountedPresets, []);
    assert.deepEqual(bare.host.list.restrictions, [
      { sessionId: agent.id, filter: { allow: ['qq_send_message', 'qq_list_conversations'] } },
    ]);
    assert.ok(bare.host.list.warnings.some((line) => line.includes('a whitelist cannot grant tools this Agent does not have')));
  } finally {
    await bare.onebot.close();
  }
});


// 用例：启动竞态里预设平面还不可见时，setup 只记一次 warn；**下一条消息**必须补挂
// 成功。漏挂的后果不只是工具面 —— 预设里的 compaction 也一起漏了，上下文会一路涨到
// 部署默认门槛（0.8×1M）才压缩，看起来就是「聊得越久越笨」（真实事故，2026-10-19）。
test('an unavailable agentPresets service is retried on the next message', async () => {
  const presets = {
    default: 'standard',
    compositions: {
      standard: ['bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'],
    },
  };
  // 前两次 get 都返回 undefined：一次给 create 前的 resolve，一次给 setup 里的补挂。
  const { onebot, host } = await boot({ agentPreset: '', allowTools: ['read'] }, { presets, presetSetupFailures: 2 });
  try {
    onebot.push(privateMessage('第一句'));
    // 这条用例要先看「setup 里没挂上」的 warn，再看「消息照常投递」——
    // 后者等的是收件箱，不是 created（假 Host 先 push created、之后才 followup）。
    const agent = await untilInbox(host, 1, 'the Agent');
    // setup 里没挂上：只记一条 warn，回复链路照常。
    assert.deepEqual(host.list.mountedPresets, []);
    assert.ok(host.list.warnings.some((line) => line.includes('agent preset') || line.includes('agentPresets')), host.list.warnings.join('|'));
    assert.equal(agent.inbox.length, 1);

    onebot.push(privateMessage('第二句'));
    await untilInbox(host, 2, 'the retry to happen on the next message');
    // 服务出现之后热路径补挂成功，预设里的工具才真正可达。
    await until(() => host.list.mountedPresets.includes('standard'), 'the preset to be mounted on retry');
    assert.deepEqual(host.list.mountedPresets, ['standard']);
    assert.deepEqual(host.list.restrictions.at(-1), { sessionId: agent.id, filter: { allow: ['read'] } });
  } finally {
    await onebot.close();
  }
});


// 用例：系统提示小节**不含**每轮会变的东西；当前发言者 / 群环境 / 当前时间都在
// user message 的第二个 text block 里。这是 2026-10-19「越聊越笨」的回归：
// 动态小节会让 DSH 每轮追加一整份系统提示（约 9k token），十几轮就 220k 上下文。
test('the channel system section stays stable while per-turn data rides on the user message', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗', { messageId: 11 }));
    const agent = await untilInbox(host, 1, 'the first turn');
    const firstSection = promptText(host, 'qq-bridge:channel');
    const firstContext = turnContextText(agent);
    assert.ok(firstContext.includes('刚跟你说话的人：kaguya'), firstContext);
    // 动态数据不能再出现在系统小节里：出现一次，DSH 就会追加一次整段提示。
    assert.ok(!firstSection.includes('刚跟你说话的人：'), firstSection);
    assert.ok(!firstSection.includes('现在是 '), firstSection);

    onebot.push(mention('还在吗', { messageId: 12, userId: 333, name: 'iroha', card: 'iroha' }));
    await untilInbox(host, 2, 'the second turn');
    const secondSection = promptText(host, 'qq-bridge:channel');
    const secondContext = turnContextText(agent);
    assert.equal(secondSection, firstSection, '系统小节必须逐字稳定，否则 DSH 每轮都会追加一份');
    assert.ok(secondContext.includes('刚跟你说话的人：iroha'), secondContext);
    assert.notEqual(secondContext, firstContext);
  } finally {
    await onebot.close();
  }
});


test('系统提示解释合并转发的格式与归属', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗', { messageId: 99 }));
    await untilInbox(host, 1, 'the first turn');
    const section = promptText(host, 'qq-bridge:channel');
    assert.match(section, /\[合并转发 N 条\]/);
    assert.match(section, /不是当前群里的发言/);
    assert.match(section, /缩进/);
  } finally {
    await onebot.close();
  }
});


// 用例：宿主那几段「编码代理 / Web GUI / 文件卡片」的小节，在 QQ 会话的作用域里
// 必须被**同名**覆盖掉（`HOST_PROMPT_SHADOWS`）—— 它们压在系统提示的首尾，比渠道小节
// 更像「我是谁」。断言的是注册的小节名字与文本，而不是拼装后的整段提示（拼装是宿主的事）。
test('the channel prompt shadows the host sections that frame a coding agent', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    await untilInbox(host, 1, 'the first turn');
    const byName = new Map(host.list.prompts.filter((entry) => entry.kind === 'section').map((entry) => [entry.name, entry]));
    for (const name of [
      'harness:identity',
      'deployment:persona-prefix',
      'ui:deliverable-file-references',
      'harness:source',
      'app:web-surface',
      'deployment:persona-suffix',
    ]) {
      assert.ok(byName.has(name), `the scenario section "${name}" must be shadowed in the agent scope`);
    }
    // 空文本 = 装配时整段丢掉；persona 前缀换成 QQ 会话自己的身份，不再自称编码代理。
    assert.equal(byName.get('app:web-surface').text, '');
    assert.equal(byName.get('deployment:persona-prefix').text, '你是一个在 QQ 群里跟人聊天的人，不是助手，也不是编程代理。');
    assert.ok(!byName.get('deployment:persona-prefix').text.includes('coding agent'));
    // 渠道小节本身还在（别把覆盖写成了替换）。
    assert.ok(byName.has('qq-bridge:channel'));
  } finally {
    await onebot.close();
  }
});


// 用例十三：agentPreset 的两种显式取值 —— 指定名字、以及 none（不挂预设）。
test('agentPreset selects the mount explicitly and none skips it', async () => {
  const presets = {
    default: 'standard',
    compositions: { minimal: ['bash'], standard: ['read', 'web_search'] },
  };

  // 这里把宿主平面收成只有 qq_*，好让「minimal 里没有 read」这件事看得清楚。
  const chosen = await boot(
    { agentPreset: 'minimal', allowTools: ['read'] },
    { presets, knownTools: ['qq_send_message', 'qq_list_conversations'] },
  );
  try {
    chosen.onebot.push(privateMessage('你好'));
    const agent = await until(() => chosen.host.list.created[0], 'the Agent');
    assert.deepEqual(chosen.host.list.mountedPresets, ['minimal']);
    assert.equal(chosen.host.list.metas[0].meta.agentPreset, 'minimal');
    // join 的预设里没有 read：白名单给不出这个 Agent 没有的能力，只保留真正存在的名字。
    assert.deepEqual(chosen.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: [] } }]);
  } finally {
    await chosen.onebot.close();
  }

  const skipped = await boot({ agentPreset: 'none' }, { presets });
  try {
    skipped.onebot.push(privateMessage('你好'));
    await until(() => skipped.host.list.created[0], 'the Agent');
    assert.deepEqual(skipped.host.list.mountedPresets, []);
    // 不挂预设就没有 agentPreset 字段，会话按「无预设」记录。
    assert.deepEqual(skipped.host.list.metas[0].meta, { cwd: skipped.cwd });
  } finally {
    await skipped.onebot.close();
  }

  // 预设名写错：告警但不打死链路，消息照常投递。
  const broken = await boot({ agentPreset: 'no_such_preset' }, { presets });
  try {
    broken.onebot.push(privateMessage('你好'));
    // 「消息照常投递」等的是收件箱里真有那条消息（理由见 untilInbox）。
    const agent = await untilInbox(broken.host, 1, 'the Agent');
    assert.deepEqual(broken.host.list.mountedPresets, []);
    assert.ok(broken.host.list.warnings.some((line) => line.includes('no_such_preset')));
    assert.equal(agent.inbox.length, 1);
  } finally {
    await broken.onebot.close();
  }
});


// 用例十四：bundle 自带的 qq 预设必须**自己就是收窄的**。
//
// 起因：standard 预设的 subagent 行开了 `modelSelectionSettings`，这个模式下
// dsh-tool-subagent 会在每个 Agent 创建时通过 `agent.ctx` 在 **Agent 自己的作用域**
// 里再注册一份工具；而 `tools.restrict()` 按设计只收窄「继承来的」工具，
// 于是 subagent 会绕过 allowTools 出现在 QQ 会话的工具表里。
// 所以：配置里的 agentPreset 必须指向本 bundle 声明的、不含任何 delegation 行的预设，
// 且 allowTools 里每个名字都要在该预设里有出处。
test('the bundled patch declares the narrowed preset the plugin mounts', async () => {
  // Loader 的 `!!js` 标签（`!!js <expression>`）不在标准 schema 里：注册成普通标量，
  // 本用例只关心结构，不关心那些表达式怎么求值。
  const jsExpression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => data });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsExpression]);
  const doc = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema });
  const rows = doc.flatMap((entry) => entry.insert ?? []);
  const bridge = rows.find((row) => row.name === '@qqbot/dsh-plugin-qq');
  assert.ok(bridge, 'the bridge row must exist in cordis.patch.yml');

  const wanted = bridge.config.agentPreset;
  const preset = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-preset' && row.config.id === wanted);
  assert.ok(preset, `agentPreset "${wanted}" must be declared in the same patch file`);

  const names = preset.config.plugins.map((row) => row.name);
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'));
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs-search'));
  assert.ok(names.includes('@deepseek-ai/dsh-tool-web'));

  // 会「在 Agent 自己作用域里注册工具」或本身就该留在白名单外的行，一个都不能有。
  const forbidden = [
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-ralph',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
  ];
  for (const name of forbidden) assert.ok(!names.includes(name), `${name} must not be in the QQ preset`);

  // 本地 skill 平面：dsh-web-app 把宿主的 skill-filesystem / tool-skill 停掉了
  // （「presets own local discovery」），所以预设里必须自己挂一份，否则
  // `<项目根>/.dsh/skills` 下的 skill 对 QQ 会话根本不存在。
  assert.ok(names.includes('@deepseek-ai/dsh-skill-filesystem'), 'the QQ preset must provide local skill discovery');
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), 'the QQ preset must provide the skill tool');

  // 白名单只能收窄、不能授予：每个放开的工具名都要能在这个预设里找到出处。
  // 本插件的工具是**宿主平面**的全局工具（不在预设里），所以直接算作出处：
  //   - qq_send_* / qq_poke / qq_list_conversations：一直注册；
  //   - qq_save_sticker：表情包目录可用时才注册（白名单里有它、但目录配到 cwd 外时，
  //     插件只是不注册那个工具 —— 这与「白名单挡掉」是两条独立的路，见 tools.js）；
  //   - qq_transcript / qq_memory：memory 开着时才注册；
  //   - qq_remind_*：定时提醒开着且任务文件在 cwd 内时才注册；
  //   - skill：由预设里的 tool-skill 提供。
  const provided = new Set([
    'qq_send_message',
    'qq_send_image',
    'qq_save_sticker',
    'qq_rename_sticker',
    'qq_list_conversations',
    'qq_poke',
    'qq_remind_create',
    'qq_remind_list',
    'qq_remind_cancel',
    // 服务器分支新增的五把主人侧工具：同为宿主平面的全局工具，注册后由各自的
    // trustedWrite / 主人名单在 execute() 里复核，不属于预设能授予的能力。
    'qq_quiet',
    'qq_settings',
    'qq_write',
    'qq_edit',
    'qq_skill',
    // 软命令 / 调试提权 / 精确时间 / 话题记忆：同样是宿主平面的全局工具。白名单里有它们
    // 不等于预设授予了能力 —— 真正的闸在 execute() 里（配置开关 + 主人名单 + TTL）。
    'qq_auto_tool',
    'qq_debug_read',
    'qq_debug_write',
    'qq_debug_list',
    'qq_debug_shell',
    'qq_debug_log',
    'qq_time',
    'qq_topic',
    'skill',
  ]);
  if (bridge.config.memory !== false) for (const name of ['qq_transcript', 'qq_memory']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-fs')) for (const name of ['read', 'read_image', 'write', 'edit']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-fs-search')) for (const name of ['glob', 'grep']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-web')) for (const name of ['web_search', 'web_fetch']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-skill')) provided.add('skill');
  for (const name of bridge.config.allowTools) {
    assert.ok(provided.has(name), `allowTools entry "${name}" has no provider in the QQ preset`);
  }
  // write / edit 由 tool-fs 提供，但必须在白名单之外（QQ 那头是只读的）。
  assert.ok(!bridge.config.allowTools.includes('write'));
  assert.ok(!bridge.config.allowTools.includes('edit'));
});


// 用例：一键脚本写进 `.env` 的取值，插件必须真的读得到。
//
// 这条链路是「发布版方便」的全部：`scripts/napcat-setup.cmd` 把 endpoint / cwd / NapCat
// 目录写进 profile 目录的 `.env`，而 DSH 只把 `.env` 变成环境变量 —— **把它们接进配置的
// 是 patch 里的 `!!js process.env.QQBOT_*`**。哪天有人图省事把某一项写死回常量，一键脚本
// 就会静默失效（用户看到的是「明明跑了脚本还是连不上」），所以在这里钉住这几行。
test('the bundled patch reads the QQBOT_* variables the Windows setup script writes', async () => {
  const jsExpression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => data });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsExpression]);
  const doc = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema });
  const bridge = doc.flatMap((entry) => entry.insert ?? []).find((row) => row.name === '@qqbot/dsh-plugin-qq');
  const expected = {
    endpoint: 'QQBOT_ENDPOINT',
    accessToken: 'QQBOT_ACCESS_TOKEN',
    cwd: 'QQBOT_CWD',
    napcatDir: 'QQBOT_NAPCAT_DIR',
    napcatAutoConfig: 'QQBOT_NAPCAT_AUTOCONFIG',
  };
  for (const [field, variable] of Object.entries(expected)) {
    const value = bridge.config[field];
    assert.equal(typeof value, 'string', `${field} 应当是 !!js 表达式`);
    assert.ok(value.includes(variable), `${field} 必须读 ${variable}（否则一键脚本写的 .env 不起作用），现在是：${value}`);
  }
});


// 用例十五：插件日志必须真的能进 journal。
//
// 本部署没有把 cordis 的 logger 接到 stdout/stderr 上（实测 `ctx.logger.warn` 只进
// 内存缓冲与 OTel），而 operator 排查「QQ 会话怎么没能力了」只能靠 journalctl ——
// 所以真实宿主里插件会把每条日志再镜像一行到 stderr。这里把这条行为钉住，
// 免得有人「顺手」把 stderr 那一份删掉。
test('plugin logs are mirrored to stderr in a real host', async () => {
  // 只挑本插件每次创建 Agent 必打的那条：先前用例留下的客户端会不定期
  // 重连并打日志，不能对其他行做断言。
  // 会话 id 由 PRIVATE_USER_ID 经 SHA-256 派生，所以这里**现算**前缀 ——
  // 写死一个常量的话，改测试用的 QQ 号就会莫名其妙地弄红这个用例。
  const prefix = sessionIdFor(`private:${PRIVATE_USER_ID}`, 0).slice(0, 8);
  const mirrored = (lines) => lines.filter((line) => line.startsWith('qq-bridge: ') && line.includes(`created ${prefix}`));
  const capture = async (hostOptions, { expectMirror }) => {
    const lines = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      const booted = await boot({}, hostOptions);
      try {
        booted.onebot.push(privateMessage('你好'));
        // 等的是「后置条件真的发生」：有 exporter 的那一侧要等那一行镜像日志真的写出来
        // （假 Host 在 create() 内部就 push created，插件是 await 回来之后才打日志，
        // 只等 created[0] 会抓不到）；没有 exporter 的那一侧等消息进了收件箱就够了 ——
        // 那已经远在「该打日志」之后，等到它仍然可能一条都没有才是这条用例要钉的。
        if (expectMirror) await until(() => mirrored(lines).length >= 1, 'the mirrored created log line');
        else await untilInbox(booted.host, 1, 'the Agent to receive its message');
      } finally {
        await booted.onebot.close();
      }
    } finally {
      process.stderr.write = original;
    }
    return mirrored(lines);
  };

  // 真实宿主的 logger 门面带 exporter() -> 镜像。
  assert.equal((await capture({ loggerExporter: true }, { expectMirror: true })).length, 1);
  // 测试用的普通日志桩没有 -> 不镜像（同时让测试输出保持干净）。
  assert.deepEqual(await capture({}, { expectMirror: false }), []);
});


// 用例十：/reset 新开一轮会话 —— 销毁活着的 Agent、换一个 Session id 重新开始，
// 而**旧会话的记录留在磁盘上**（不删）。指令本身不会被投递给 Agent。
test('the reset command opens a new session instead of deleting the old one', async () => {
  const { onebot, host, sessionsRoot } = await boot({ resetUsers: [String(PRIVATE_USER_ID)] });
  try {
    onebot.push(privateMessage('你好'));
    const first = await untilInbox(host, 1, 'the Agent to be created');
    // 假后端在 create 时已落地磁盘记录，先确认它存在。
    const storedDir = join(sessionsRoot, '--fake-project--', first.id);
    assert.ok(existsSync(storedDir));

    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');

    // 旧 Agent 被销毁，但旧会话的磁盘记录**保留**下来当存档。
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
    assert.ok(existsSync(storedDir), 'the old session must be kept on disk, not deleted');
    // 指令没有进 Agent 的收件箱（只有最开始那条「你好」）。
    assert.equal(first.inbox.length, 1);

    // 再来一条消息：必须是新的 Agent（新对象）**并且换了 Session id**，
    // 证明新一轮既没有复用旧 Agent，也没有 resume 旧会话。
    onebot.push(privateMessage('还记得我刚才说什么吗'));
    // 第二个 Agent 也要等它的消息投递到位：下面直接读 second.inbox[0]，
    // 只等 created[1] 会读到空收件箱（假 Host 先记 created 再 followup）。
    const second = await untilInbox(host, 1, 'a fresh Agent after the reset', 1);
    assert.notEqual(second, first);
    assert.notEqual(second.id, first.id, 'the new round must use a different session id');
    assert.equal(second.inbox.length, 1);
    assert.equal(second.inbox[0].content[0].text, '还记得我刚才说什么吗');
    // 会话列表里报的也是新一轮的 id。
    const listed = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.equal(listed.sessions[0].session_id, second.id);
    assert.equal(listed.sessions[0].session_round, 1);
  } finally {
    await onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});


// 用例：/reset 开到了第几轮是**落盘**的 —— 插件重启后不该把 reset 之前那段会话
// resume 回来（那等于 /reset 白按了）。两个实例共用一个会话根目录模拟同一个部署重启。
test('the session round survives a plugin restart', async () => {
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'qq-bridge-restart-'));
  // 其余节奏参数压到 0：这个用例关心的是「跨进程还在不在第 1 轮」，不是时序。
  // endpoint 必须留给 boot 自己填（假 OneBot 服务端的地址）；cwd 也交给 boot
  // （它会给一个临时目录 —— 写死 `/tmp` 在 Windows 上会落到 `D:\tmp` 去）。
  const config = { readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, batchWindowMs: 0, resetUsers: [String(PRIVATE_USER_ID)] };
  let first;
  let second;
  let before;
  try {
    // 第一段：说一句 → /reset（第 1 轮）。
    first = await boot({ ...config }, { sessionsRoot });
    first.onebot.push(privateMessage('你好'));
    before = await until(() => first.host.list.created[0], 'the first Agent');
    assert.equal(before.id, sessionIdFor('private:100000002', 0));
    first.onebot.push(privateMessage('/reset'));
    await until(
      () => first.onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    // 标记是在确认发出**之前**就写完的（`resetConversation` 会 await 它）：所以这里
    // 直接就能看到它，这正是「说完就重启也不会退回第 0 轮」的保证。
    const marker = join(sessionsRoot, 'reset', 'private-100000002.json');
    await until(() => existsSync(marker), 'the session round marker on disk');
  } finally {
    await first?.onebot.close();
  }
  try {
    // 第二段：同一个会话根目录重新起一个插件（进程重启），再来一条消息。
    second = await boot({ ...config }, { sessionsRoot });
    second.onebot.push(privateMessage('重启之后呢'));
    const after = await until(() => second.host.list.created[0], 'the Agent after the restart');
    // 重启后仍然在第 1 轮：既不是第 0 轮那个 id（那会把 reset 前的会话 resume 回来），
    // 也不是新一轮新算出来的另一个 id —— 第 1 轮的 id 是确定性的、跨进程一致的。
    assert.notEqual(after.id, sessionIdFor('private:100000002', 0));
    assert.equal(after.id, sessionIdFor('private:100000002', 1));
    assert.notEqual(after.id, before.id);
  } finally {
    await second?.onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});


// 用例：只有 resetUsers 里的人能重置。
//
// 默认是**空白名单 = 谁都不能**（与 allowUsers 的「空 = 不限制」相反）：群消息是不可信
// 输入，一个「没配就等于人人可用」的重置指令，等于让群里任何一个人都能悄悄把会话记忆
// 重开一轮。没权限的人**静默忽略**：不重置、也不告诉它「你没有权限」。
test('the reset command only works for accounts listed in resetUsers', async () => {
  const { onebot, host, sessionsRoot } = await boot({
    resetUsers: [String(PRIVATE_USER_ID)],
    batchWindowMs: 200,
    batchMaxWaitMs: 400,
  });
  try {
    // ① 没权限的人发 /reset：连攒批都不该被它提前投出去（权限判断在 flushBatch 之前），
    //    也不该有任何回复。
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 999,
      sender: { nickname: 'soyo' },
      message: [{ type: 'text', data: { text: '/reset' } }],
    });
    await settle(600); // 超过 batchMaxWaitMs，够攒批自然投出去了
    assert.equal(host.list.created.length, 0, 'a stranger must not be able to open a session at all');
    assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false, 'and must get no reply');

    // ② 权限里的人发 /reset：照常开新一轮。
    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation for the allowed account',
    );
    assert.equal(confirmation.params.user_id, String(PRIVATE_USER_ID));
    // 真的换了轮次：磁盘上落下了第 1 轮的标记（0 轮那个会话还没被创建过，所以用文件名断言）。
    const marker = join(sessionsRoot, 'reset', 'private-100000002.json');
    await until(() => existsSync(marker), 'the round marker for private:100000002');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).count, 1);
  } finally {
    await onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});


// 用例：群里重置看的是**发言者**的 QQ 号，不是群号；而没权限的人那条连模型都进不去。
test('in a group the reset permission follows the speaker, not the group', async () => {
  const { onebot, host } = await boot({ resetUsers: [String(GROUP_USER_ID)] });
  try {
    // 群里另一个人 @它发 /reset：不是指令（没权限），也不会被当成一句话投给模型 ——
    // 它只是被静默丢掉，所以不会凭空建出一个会话。
    onebot.push(mention('/reset', { userId: 10001, card: 'soyo' }));
    await settle(200);
    assert.equal(onebot.calls.some((call) => call.action === 'send_group_msg'), false, 'no reply for the stranger');
    assert.equal(host.list.created.length, 0, 'the stranger must not open a session either');

    // 权限里的那个人 @它发 /reset：生效。
    onebot.push(mention('/reset'));
    await until(
      () => onebot.calls.some((call) => call.action === 'send_group_msg' && String(call.params.message).includes('已开始新会话')),
      'the reset confirmation from the allowed speaker',
    );
  } finally {
    await onebot.close();
  }
});


// 用例十一：resetCommand 留空即禁用；此时 /reset 只是一句普通消息。
test('an empty resetCommand disables the reset handling', async () => {
  const { onebot, host } = await boot({ resetCommand: '' });
  try {
    onebot.push(privateMessage('/reset'));
    const agent = await untilInbox(host, 1, 'the Agent to be created');
    assert.equal(agent.inbox.length, 1);
    assert.equal(agent.inbox[0].content[0].text, '/reset');
    assert.deepEqual(host.list.disposed, []);
    // 没有任何「已开始新会话」的回复发出。
    assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false);
  } finally {
    await onebot.close();
  }
});


// 用例：静默太久（idleResetHours）之后的第一条消息自动开新一轮 —— 不需要任何人
// 发 `/reset`。这里取一个很小的小时数（0.00002 ≈ 72ms），等够它再发第二条。
test('idleResetHours opens a new round after a long silence', async () => {
  const { onebot, host } = await boot({ idleResetHours: 0.00002 });
  try {
    onebot.push(privateMessage('第一句'));
    const first = await untilInbox(host, 1, 'the first Agent');
    completeTurn(host, first, '嗯');
    await new Promise((resolve) => setTimeout(resolve, 120));
    onebot.push(privateMessage('第二句'));
    // 换轮之后同样要等「那条触发换轮的消息」真的投进新 Agent 的收件箱。
    const second = await untilInbox(host, 1, 'a fresh Agent after the idle gap', 1);
    assert.notEqual(second.id, first.id, '静默超过 idleResetHours 之后必须换一个 Session id');
    assert.ok(host.list.disposed.includes(first.id), '旧 Agent 必须销毁，不能让两个同时挂在同一个会话上');
    assert.equal(second.inbox[0].content[0].text, '第二句', '触发换轮的那条消息本身不能被丢掉');
  } finally {
    await onebot.close();
  }
});


// 用例：没静默够就不换轮；idleResetHours: 0（默认）等于关闭。
test('a short pause and the default setting both keep the same round', async () => {
  const { onebot, host } = await boot({ idleResetHours: 12 });
  try {
    onebot.push(privateMessage('第一句'));
    const first = await untilInbox(host, 1, 'the first Agent');
    completeTurn(host, first, '嗯');
    onebot.push(privateMessage('第二句'));
    await until(() => first.inbox.length >= 2, 'the second message to reach the same Agent');
    assert.equal(host.list.created.length, 1, '12 小时的静默门槛没到，不该换轮');
    assert.equal(first.id, host.list.created[0].id);
  } finally {
    await onebot.close();
  }

  const off = await boot();
  try {
    off.onebot.push(privateMessage('第一句'));
    const agent = await untilInbox(off.host, 1, 'the first Agent');
    completeTurn(off.host, agent, '嗯');
    await new Promise((resolve) => setTimeout(resolve, 120));
    off.onebot.push(privateMessage('第二句'));
    await until(() => agent.inbox.length >= 2, 'the second message to reach the same Agent');
    assert.equal(off.host.list.created.length, 1, 'idleResetHours 默认 0 = 关闭，永远不自动换轮');
  } finally {
    await off.onebot.close();
  }
});


// 用例七：会话列表工具能报告实时连接状态、模型路由与在线群列表。
test('the conversation list tool reports the live QQ route', async () => {
  const { onebot, host } = await boot();
  try {
    const value = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.equal(value.connected, true);
    // self_id 来自真实的 get_login_info 往返，且被统一成字符串。
    assert.equal(value.self_id, String(SELF_ID));
    // source=default 表示模型来自部署默认选择（配置里没填 provider/model）。
    assert.deepEqual(value.route, { provider: 'deepseek-official', model: 'deepseek-flash', source: 'default', error: '' });
    assert.deepEqual(value.groups, [{ id: '100000001', name: '示例群' }]);
  } finally {
    await onebot.close();
  }
});


// ---------------------------------------------------------------------------
// 「像真实的群友」相关行为：群聊上下文、说话节奏、口吻提示、引用回复。
// ---------------------------------------------------------------------------

// 用例十三：没被 @ 的群聊消息不该建 Agent，但应成为下一次回复的上下文。
test('group chatter the bot was not addressed in becomes ambient context', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(groupMessage([{ type: 'text', data: { text: '晚上吃啥' } }], { messageId: 11 }));
    onebot.push(groupMessage([{ type: 'text', data: { text: '随便' } }], { userId: 333, name: 'iroha', card: 'iroha', messageId: 12 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // 只是围观：不该为此创建任何 Agent。
    assert.equal(host.list.created.length, 0);

    onebot.push(mention('你们说呢', { messageId: 13 }));
    // 环境块是从收件箱里那条消息的第二个 text block 取的：等消息真投进去再看，
    // 否则读到的是空串（这里要断言「闲聊出现在环境块里」，空串会假红）。
    const agent = await untilInbox(host, 1, 'the group Agent');
    const text = turnContextText(agent);
    // 之前的闲聊按「昵称: 内容」出现，模型因此知道大家在聊什么。
    assert.ok(text.includes('kaguya: 晚上吃啥'), text);
    assert.ok(text.includes('iroha: 随便'), text);
    // 被 @ 的那条走 user message 的第一块，不在环境块里重复一遍。
    assert.ok(!text.includes('你们说呢'));
  } finally {
    await onebot.close();
  }
});


// 用例十四：ambientMessages: 0 时群聊上下文完全不进提示词。
test('ambientMessages: 0 disables the group context', async () => {
  const { onebot, host } = await boot({ ambientMessages: 0 });
  try {
    onebot.push(groupMessage([{ type: 'text', data: { text: '晚上吃啥' } }], { messageId: 11 }));
    onebot.push(mention('你们说呢', { messageId: 12 }));
    // 这条断言的是「没有」：收件箱空着时也会「没有」，所以必须等消息真投进去，
    // 否则这句会变成永远成立的假绿。
    const agent = await untilInbox(host, 1, 'the group Agent');
    const text = turnContextText(agent);
    assert.ok(!text.includes('晚上吃啥'));
    // 环境块的表头（「群里最近的消息（旧 → 新；…）」）不该出现。注意别只匹配
    // 「群里最近的消息」这几个字 —— 图片那一条静态说明里也会提到它。
    assert.ok(!text.includes('群里最近的消息（旧 → 新'), text);
  } finally {
    await onebot.close();
  }
});
