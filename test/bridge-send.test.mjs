/**
 * 集成测试分册：发送链路（分条 / 标点 / 引用 / @ / 上下文）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-send.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { isEmojiOnlyMessage, isStickerSegment, repeatableText, splitBurst, typingDelayMs } from '../onebot.js';
import { SELF_ID, promptText, turnContextText, until, untilInbox, privateMessage, groupMessage, mention, completeTurn, sentTexts, boot } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


/**
 * 模拟「模型只写了思考、没有写出正文」的一轮：认领 → 只有 reasoning 块 → turn/end。
 *
 * 2026-10-22 私聊的真实事故：模型最后一步只返回了 reasoning（要发的话就写在里面），
 * 没有任何 text 块 —— 插件当时把空回复静默丢掉了，对方等半分钟只等到一个「？」。
 */
function emptyAssistantTurn(host, agent, turn) {
  const session = { id: agent.id };
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[agent.inbox.length - 1], turn });
  host.list.emit('session/event', session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'reasoning', text: '想好了要发的话，但只写在思考里' }] } },
  });
  host.list.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
}


// 用例十五：自动回复拆成几条短消息，而不是一屏糊上来；条与条之间有打字间隔。
test('an automatic reply is burst into short messages', async () => {
  const reply = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  // 固定 30ms/条：既验证延迟确实接到了配置（delayJitter=0 时是确定值），又不拖慢测试。
  const { onebot, host } = await boot({
    burstMaxChars: 12,
    burstMaxParts: 3,
    readDelayMs: 0,
    minDelayMs: 30,
    maxDelayMs: 30,
    charsPerSecond: 1,
    delayJitter: 0,
  });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');
    const started = Date.now();
    completeTurn(host, agent, reply);

    const sent = await until(() => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.length === 3 ? list : undefined;
    }, 'the burst to be delivered');
    // 短气泡句末的「。」在发送前被剥掉（stripShortPeriod）；问号/感叹号不动。
    assert.deepEqual(sent, ['今天天气不错', '要不出去走走？', '顺便吃个饭吧！']);
    // 每一条都在目标长度内（整体不超协议上限自然更没问题）。
    assert.ok(sent.every((part) => part.length <= 12));
    // 两条间隔 × 30ms：证明「打字延迟」真的按配置生效，而不是一口气发完。
    assert.ok(Date.now() - started >= 50, 'the burst should be paced out, not sent at once');
  } finally {
    await onebot.close();
  }
});


// 用例十五·补：模型只写了思考、没有正文时，重问一次而不是静默丢人。
test('an empty assistant message is re-asked once instead of leaving the user hanging', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('睡了吗'));
    const agent = await untilInbox(host, 1, 'the private message');
    emptyAssistantTurn(host, agent, 1);
    // 重问走的是同一个会话：一条新的 user message 被投进 Agent，而不是发一条空气泡。
    const retried = await untilInbox(host, 2, 'the empty-reply retry');
    assert.equal(retried.inbox.length, 2);
    const nudge = retried.inbox[1].content[0].text;
    // 必须说清「不是对方发来的」：否则模型会回一句「怎么了」。
    assert.match(nudge, /不是对方发来的/);
    assert.match(nudge, /没有写出要发的话/);
    assert.equal(sentTexts(onebot, 'send_private_msg').length, 0, '空回复绝不能变成一条空气泡');

    // 重问这一轮正常回复：发出去的是它真正要说的话。
    completeTurn(host, retried, '没什么，睡不着', 2);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the retried reply');
    assert.equal(sent, '没什么，睡不着');
  } finally {
    await onebot.close();
  }
});


// 用例十五·补：重问也空回复时只记一次，不再往下循环（否则会和模型互相追问）。
test('a second empty reply stops instead of re-asking again', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the private message');
    emptyAssistantTurn(host, agent, 1);
    const retried = await untilInbox(host, 2, 'the empty-reply retry');
    emptyAssistantTurn(host, retried, 2);
    // 没有第三次投递，也没有任何消息发到 QQ。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(retried.inbox.length, 2);
    assert.equal(sentTexts(onebot, 'send_private_msg').length, 0);
  } finally {
    await onebot.close();
  }
});


// 用例十六：humanize: false 回到旧行为 —— 一条整段直接发出。
test('humanize: false restores the single-message reply', async () => {
  const reply = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  const { onebot, host } = await boot({ humanize: false, burstMaxChars: 12 });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');
    completeTurn(host, agent, reply);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the reply');
    assert.equal(sent, reply);
    assert.equal(sentTexts(onebot, 'send_private_msg').length, 1);
  } finally {
    await onebot.close();
  }
});


// 用例十六·补：burstMaxMessages: 1 —— 一轮回复不管模型写了几行、几个句号，
// 都并成一条发出去（模型爱拆「短句 + 长句」两拍，光靠提示词压不住）。
test('burstMaxMessages: 1 collapses a whole reply into a single message', async () => {
  // 同一个句子里被标点拆出来的几段：接回去应当和原文一模一样（不留痕）。
  const oneLine = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  const first = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    first.onebot.push(privateMessage('在吗'));
    // 等消息真的进了收件箱再开这一轮：只等 created[0] 会抢在 followup 之前，
    // completeTurn 于是拿着 message: undefined 去开 turn（理由见 untilInbox）。
    const agent = await untilInbox(first.host, 1, 'the Agent');
    completeTurn(first.host, agent, oneLine);
    const sent = await until(() => sentTexts(first.onebot, 'send_private_msg')[0], 'the single reply');
    assert.deepEqual(sentTexts(first.onebot, 'send_private_msg'), [oneLine]);
    assert.equal(sent, oneLine);
  } finally {
    await first.onebot.close();
  }

  // 模型自己换行写的两段：跨行合并用空格接，仍然只有一条。
  const multiline = '今天天气不错。\n要不出去走走？顺便吃个饭吧！';
  const second = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    second.onebot.push(privateMessage('在吗'));
    // 同上：完成一轮的前提是那条消息已经在收件箱里。
    const agent = await untilInbox(second.host, 1, 'the Agent');
    completeTurn(second.host, agent, multiline);
    await until(() => sentTexts(second.onebot, 'send_private_msg')[0], 'the single reply');
    assert.deepEqual(sentTexts(second.onebot, 'send_private_msg'), ['今天天气不错。 要不出去走走？顺便吃个饭吧！']);
  } finally {
    await second.onebot.close();
  }

  // 长内容不会被这一段吞掉：并条只影响「分几条」，内容一字不动；真的超过协议上限
  // （maxReplyChars）时仍然按上限切成两段 —— 那是 QQ 协议的限制，不是这条配置。
  const third = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, maxReplyChars: 20, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    third.onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(third.host, 1, 'the Agent');
    completeTurn(third.host, agent, oneLine);
    await until(() => sentTexts(third.onebot, 'send_private_msg').length === 2, 'the protocol-limit chunks');
    const chunks = sentTexts(third.onebot, 'send_private_msg');
    assert.ok(chunks.every((part) => part.length <= 20));
    assert.equal(chunks.join(''), oneLine, '内容必须一字不少');
  } finally {
    await third.onebot.close();
  }
});


// 聊天型 / 信息型都按模型写的条数发：没有条数上限，也没有「超出的并进最后一条」。
test('chat and informational replies both send every line the model wrote', async () => {
  const options = {
    burstMaxChars: 12,
    burstMaxParts: 3,
    burstMaxMessages: 0,
    burstSingleMaxChars: 20,
    readDelayMs: 0,
    minDelayMs: 0,
    maxDelayMs: 0,
    delayJitter: 0,
  };

  // 聊天型（去掉空白 7 字 ≤ 门槛 20）：两行就是两条，不会被并成一条。
  const short = await boot(options);
  try {
    short.onebot.push(privateMessage('在吗'));
    // 等后置条件：消息已投递（否则这一轮根本没开，等到的是 5 秒超时而不是条数）。
    const agent = await untilInbox(short.host, 1, 'the Agent');
    completeTurn(short.host, agent, '在的\n刚吃完');
    const sent = await until(() => {
      const list = sentTexts(short.onebot, 'send_private_msg');
      return list.length === 2 ? list : undefined;
    }, 'both chat bubbles');
    assert.deepEqual(sent, ['在的', '刚吃完']);
  } finally {
    await short.onebot.close();
  }

  // 信息型（去掉空白 28 字 > 门槛 20）：换行照旧分条，一行一条短句。
  const long = '今天天气不错\n要不要出去走走\n顺便吃个饭吧\n附近新开的店还不错';
  const deep = await boot(options);
  try {
    deep.onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(deep.host, 1, 'the Agent');
    completeTurn(deep.host, agent, long);
    const sent = await until(() => {
      const list = sentTexts(deep.onebot, 'send_private_msg');
      return list.length === 4 ? list : undefined;
    }, 'the split answer');
    assert.deepEqual(sent, ['今天天气不错', '要不要出去走走', '顺便吃个饭吧', '附近新开的店还不错']);
    assert.ok(sent.every((part) => part.length <= 12));
  } finally {
    await deep.onebot.close();
  }
});


// 没有掷骰、也没有条数上限：模型写五条就发五条（旧版本默认最多 3 条，超出的并进最后一条）。
test('bubble count has no cap: five lines become five messages', async () => {
  const { onebot, host } = await boot({ readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    onebot.push(privateMessage('在吗'));
    // 五条气泡的前提是这一轮真的开起来了：等消息进收件箱，不是等 created[0]。
    const agent = await untilInbox(host, 1, 'the Agent');
    completeTurn(host, agent, '在的\n刚吃完\n你呢\n要不要出去走走\n顺便吃个饭');
    const sent = await until(() => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.length === 5 ? list : undefined;
    }, 'all five bubbles');
    assert.deepEqual(sent, ['在的', '刚吃完', '你呢', '要不要出去走走', '顺便吃个饭']);
  } finally {
    await onebot.close();
  }
});


// 标点清洗：短气泡句末的「。」在发送前剥掉；长气泡保留正常标点。
test('stripShortPeriod removes the trailing full stop of a short bubble', async () => {
  const { onebot, host } = await boot({ readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0, shortPeriodMaxChars: 40 });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');
    completeTurn(host, agent, '在的。');
    await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the reply');
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), ['在的']);
  } finally {
    await onebot.close();
  }
});


// 用例十七：群聊回复可以带上指向（引用被回复的消息 / @ 对方），且只挂在第一条上。
test('group replies can quote or mention the message they answer', async () => {
  // quote（默认）：reply 段引用入站消息的 message_id，正文跟在后面。
  const quoted = await boot({ replyStyle: 'quote' });
  try {
    quoted.onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await untilInbox(quoted.host, 1, 'the group Agent');
    completeTurn(quoted.host, agent, '在的');
    const sent = await until(() => sentTexts(quoted.onebot)[0], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4242' } },
      { type: 'text', data: { text: '在的' } },
    ]);
  } finally {
    await quoted.onebot.close();
  }

  // at：改成 @ 回提问者。
  const mentioned = await boot({ replyStyle: 'at' });
  try {
    mentioned.onebot.push(mention('在吗', { messageId: 4242, userId: 100000003 }));
    // 等消息已投递：引用段是按这一轮真正收到的那条算的，抢跑会拿不到 message。
    const agent = await untilInbox(mentioned.host, 1, 'the group Agent');
    completeTurn(mentioned.host, agent, '在的');
    const sent = await until(() => sentTexts(mentioned.onebot)[0], 'the mentioned reply');
    assert.deepEqual(sent, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: '在的' } },
    ]);
  } finally {
    await mentioned.onebot.close();
  }

  // plain：保持纯文本，私聊任何时候都不带指向段。
  const plain = await boot({ replyStyle: 'plain' });
  try {
    plain.onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await untilInbox(plain.host, 1, 'the group Agent');
    completeTurn(plain.host, agent, '在的');
    assert.equal(await until(() => sentTexts(plain.onebot)[0], 'the plain reply'), '在的');
  } finally {
    await plain.onebot.close();
  }
});


// 用例十七之二：auto（默认）—— 紧挨着回不引用，中间有人插话才引用。
test('auto reply style quotes only when someone spoke in between', async () => {
  const { onebot, host } = await boot({ replyStyle: 'auto' });
  try {
    // 没人插话：一轮问答本来就看得出来在回谁，裸文本就够了。
    onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '在的');
    assert.equal(await until(() => sentTexts(onebot)[0], 'the plain reply'), '在的');

    // @ 之后群里又有人说话：回复带上引用，否则看不出在回哪一条。
    onebot.push(mention('几点走', { messageId: 4243 }));
    await until(() => agent.inbox.length === 2, 'the second message to be delivered');
    onebot.push(groupMessage([{ type: 'text', data: { text: '我也想问' } }], { userId: 333, name: 'iroha', card: 'iroha', messageId: 4244 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    completeTurn(host, agent, '八点', 2);
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4243' } },
      { type: 'text', data: { text: '八点' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例十七之二·补：中间隔着**机器人自己刚发的话**时也要引用。
//
// 真实日志里的样子（group:100000001，15:33）：iroha 问天气（第 44 轮，入站时快照 S）→ 三秒后
// 另一个人发来一张表情包（第 45 轮，快照 S+1）→ 第 44 轮的回复「桂林今天多云…」发出去
// （我在这个群里说了话，进度 S+2）→ 第 45 轮回「又发我照片干嘛」时，被回的那张图后面已经
// 多了一条**我自己的**消息，得带引用才看得出来在回哪条。
//
// 这一票是在 `sendOne` 里发的，不是等回灌：NapCat 的 `reportSelfMessage` 关着，自己发出的
// 消息不会作为事件回来，所以用例里也只推别人的消息、靠真发出去的那条回复推动进度。
test("auto reply style also counts the bot's own replies in between", async () => {
  const { onebot, host } = await boot({ replyStyle: 'auto' });
  try {
    // 第 44 轮：iroha 问天气；不等它回完，紧接着又来一条（这条排在下一轮）。
    onebot.push(mention('今天桂林天气怎么样', { messageId: 4241 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    await until(() => agent.inbox.length === 1, 'the weather question to reach the Agent');
    onebot.push(mention('又发我照片', { messageId: 4242 }));
    await until(() => agent.inbox.length === 2, 'the second message to queue up behind it');

    // 第 44 轮正常发完：这时候群里已经出现了我自己的话（「被回的那条被挤远」）。
    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 44 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 44, step: 1, message: { content: [{ type: 'text', text: '桂林今天多云，23到34度' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 44, reason: { kind: 'completed' } } });
    // 问天气的时候另一个人插了一句，所以第 44 轮自己就带引用。
    assert.deepEqual(await until(() => sentTexts(onebot)[0], 'the weather reply'), [
      { type: 'reply', data: { id: '4241' } },
      { type: 'text', data: { text: '桂林今天多云，23到34度' } },
    ]);

    // 第 45 轮回那张照片：中间只多了我自己那句话，也得点名。
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[1], turn: 45 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 45, step: 1, message: { content: [{ type: 'text', text: '又发我照片干嘛' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 45, reason: { kind: 'completed' } } });
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted second reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4242' } },
      { type: 'text', data: { text: '又发我照片干嘛' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例十七之四：被回复的那条本身只有表情时不引用，带文字的表情照旧引用。
test('a reply never quotes a message that is only an emoji', async () => {
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    // 只有表情（系统表情 face 段）：引用块会把那张表情再贴一遍，所以裸文本回。
    onebot.push(groupMessage(
      [{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'face', data: { id: '13' } }],
      { messageId: 4250 },
    ));
    const agent = await untilInbox(host, 1, 'the emoji-only message');
    completeTurn(host, agent, '？', 1);
    assert.equal(await until(() => sentTexts(onebot)[0], 'the plain reply'), '？');

    // 文字 + 表情：文字才是可以接的话头，引用照旧。
    onebot.push(groupMessage(
      [
        { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
        { type: 'text', data: { text: '笑死' } },
        { type: 'face', data: { id: '13' } },
      ],
      { messageId: 4251 },
    ));
    await until(() => agent.inbox.length === 2, 'the second message');
    completeTurn(host, agent, '确实', 2);
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4251' } },
      { type: 'text', data: { text: '确实' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例十七之三：一次回复里的换行拆成多条独立消息，且引用只挂在第一条上。
test('a multiline group reply becomes separate messages with the quote only on the first', async () => {
  // 这条用例验的是「换行 = 分条 + 引用只挂第一个文字气泡」；条数上限与并条是另一组用例。
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '在的\n刚吃完\n你呢');
    const sent = await until(() => {
      const list = sentTexts(onebot);
      return list.length === 3 ? list : undefined;
    }, 'the three messages to be delivered');
    // 三条独立消息；只有第一条带 reply 段，后两条是纯文本。
    assert.deepEqual(sent, [
      [
        { type: 'reply', data: { id: '4242' } },
        { type: 'text', data: { text: '在的' } },
      ],
      '刚吃完',
      '你呢',
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例：回复里可以 @ 别人（`[[@昵称]]` → at 段），而正文里**不会**出现 QQ 号。
//
// 这一组的出发点是「模型看不见、也不该写出任何 QQ 号」：提示词里只给它昵称，
// 它想点名就写 `[[@昵称]]`，插件负责换成真正的 at 段。
test('a reply can @ somebody by nickname, and raw QQ numbers never reach the chat', async () => {
  const { onebot, host } = await boot({ replyStyle: 'plain' });
  try {
    // 第一个人 @ 了它，第二个人的名字要靠环境上下文/自己发言进名单。
    onebot.push(mention('在吗', { messageId: 5001, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '[[@kaguya]] 在的', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the mentioned reply');
    assert.deepEqual(sent, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 在的' } },
    ]);

    // 认不出来的名字：整个标记丢掉，绝不会把 `[[@…]]` 原样糊进群里。
    onebot.push(mention('还有人吗', { messageId: 5002 }));
    await until(() => agent.inbox.length === 2, 'the second message');
    completeTurn(host, agent, '[[@查无此人]] 没别人了', 2);
    const second = await until(() => sentTexts(onebot)[1], 'the reply with an unknown name');
    assert.deepEqual(second, [{ type: 'text', data: { text: ' 没别人了' } }]);
    assert.ok(!JSON.stringify(second).includes('[['), JSON.stringify(second));

    // 整条回复只有一个没法解析的 @：什么都不发（而不是发一串乱码）。
    onebot.push(mention('你倒是说啊', { messageId: 5003 }));
    await until(() => agent.inbox.length === 3, 'the third message');
    completeTurn(host, agent, '[[@查无此人]]', 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sentTexts(onebot).length, 2);

    // 整条回复只有一个**解析得出来**的 @：只发一个 at 段，一个字都不说。
    onebot.push(mention('叫我干嘛', { messageId: 5004 }));
    await until(() => agent.inbox.length === 4, 'the fourth message');
    completeTurn(host, agent, '[[@kaguya]]', 4);
    const onlyAt = await until(() => sentTexts(onebot)[2], 'the @-only reply');
    assert.deepEqual(onlyAt, [{ type: 'at', data: { qq: '100000003' } }]);

    // `[[@全体成员]]` 是群里唯一认的「所有人」，且不依赖名单。
    onebot.push(mention('通知一下', { messageId: 5005 }));
    await until(() => agent.inbox.length === 5, 'the fifth message');
    completeTurn(host, agent, '[[@全体成员]] 都来看看这个', 5);
    const everyone = await until(() => sentTexts(onebot)[3], 'the all-mention reply');
    assert.deepEqual(everyone, [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 都来看看这个' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例：@ 的名单按会话隔离 —— 一个人在群里说过话，不代表能在私聊里 @ 到他。
test('the @ list is per conversation: a group member is not mentionable in a private chat', async () => {
  const { onebot, host } = await boot({ replyStyle: 'plain' });
  try {
    // 先在群里认识 kaguya（他 @ 了机器人）。
    onebot.push(mention('在吗', { messageId: 5101, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    await untilInbox(host, 1, 'the group Agent');
    // 私聊里对方是另一个人，kaguya 不在这个会话的名单里。
    onebot.push(privateMessage('你好'));
    // 等它**并且**等消息落进它的收件箱：只看 `created` 会抢在 followup 之前拿到 Agent，
    // 于是 completeTurn 拿着 `message: undefined` 去开 turn（AGENTS §8 那条竞态）。
    const priv = await until(
      () => host.list.created.find((entry) => entry.id !== host.list.created[0].id && entry.inbox.length >= 1),
      'the private Agent to receive its message',
    );
    completeTurn(host, priv, '[[@kaguya]] 你好', 1);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    // 私聊里也没有「全体成员」这回事：都解析不出来，于是只剩正文。
    assert.deepEqual(sent, [{ type: 'text', data: { text: ' 你好' } }]);
  } finally {
    await onebot.close();
  }
});


// 用例：@ 标记与引用指向可以同时挂在同一条消息上（顺序是「先指向、后正文」）。
test('an @ in the reply keeps the quote head in front of it', async () => {
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 5201, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '[[@kaguya]] 在的', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '5201' } },
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 在的' } },
    ]);
  } finally {
    await onebot.close();
  }
});


// 用例：出站工具（qq_send_message）也能 @ 人 —— 但它只认得「这个会话聊过的人」。
test('qq_send_message resolves [[@nickname]] against the conversation it is sending to', async () => {
  const { onebot, host } = await boot();
  try {
    const tool = host.tools.get('qq_send_message');
    // 先从 QQ 会话里认识 kaguya（他在群里 @ 了机器人）。
    onebot.push(mention('在吗', { messageId: 5301, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    await until(() => host.list.created[0], 'the group Agent');
    // 工具是 Agent 的显式动作：这里直接调用，模拟模型点名要 @ 群里的人。
    const value = await tool.execute({ target_type: 'group', target_id: '100000001', message: '[[@kaguya]] 出来说话' }, {});
    assert.deepEqual(value, { target_type: 'group', target_id: '100000001', parts: 1 });
    const sent = onebot.calls.filter((call) => call.action === 'send_group_msg').at(-1);
    assert.deepEqual(sent.params.message, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 出来说话' } },
    ]);

    // 一个从没聊过的群：名单是空的，@ 解析不出来 —— 退化成纯文本，而不是报错。
    const stranger = await tool.execute({ target_type: 'group', target_id: '999999999', message: '[[@kaguya]] 在吗' }, {});
    assert.equal(stranger.parts, 1);
    const last = onebot.calls.filter((call) => call.action === 'send_group_msg').at(-1);
    assert.deepEqual(last.params.message, [{ type: 'text', data: { text: ' 在吗' } }]);
  } finally {
    await onebot.close();
  }
});



// 用例十八：修两个「不像真人」的旧毛病 —— 群名从第二条消息起不再丢失，
// 提示词里的「刚跟你说话的人」也永远是当前这位，而不是建 Agent 时的第一位。
//
// 群名现在走「本轮情境」（系统小节里**一个字都不能变**）：系统提示一旦因为群名这种
// 查得到查不到的东西改一个字，DSH 就会把整份人设 + 硬性规则再追加一遍（见下面
// 「群名查不到」那个用例）。
test('the turn context keeps the group name and always names the latest speaker', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗', { messageId: 11 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const first = promptText(host, 'qq-bridge:channel');
    // 群名来自 get_group_info（入站事件里没有），第一条消息时就该查到 —— 但只进情境。
    assert.ok(first.includes('100000001'), first);
    assert.ok(!first.includes('示例群'), '群名不进系统提示');
    const firstContext = await until(() => {
      const text = turnContextText(agent);
      return text.includes('示例群') && text.includes('刚跟你说话的人：kaguya') ? text : undefined;
    }, 'the group name and the speaker in the turn context');

    onebot.push(mention('还在吗', { messageId: 12, userId: 333, name: 'iroha', card: 'iroha' }));
    await until(() => agent.inbox.length === 2, 'the second message to be delivered');
    const second = await until(() => {
      const text = turnContextText(agent);
      return text.includes('刚跟你说话的人：iroha') ? text : undefined;
    }, 'the prompt to name the new speaker');
    assert.ok(second.includes('这个群叫「示例群」'), second);
    // 系统小节逐字不变：这是「重启后整份提示词被追加一遍」的防线。
    const afterSecond = promptText(host, 'qq-bridge:channel');
    assert.equal(afterSecond, first);
  } finally {
    await onebot.close();
  }
});


// 用例十八·二：群名查询失败（重启后 NapCat 还没就绪、或群里改了名）不能让系统提示变一个字。
// 一次网络抖动就重写 7.5k 字的人设，模型会看到两份硬性规则 —— 真实事故里那几轮回复
// 立刻变成一句式的照章办事。
test('the channel section does not depend on the group name lookup', async () => {
  const withName = await boot();
  const withoutName = await boot({}, {}, { groupInfoFails: true });
  try {
    withName.onebot.push(mention('在吗', { messageId: 21 }));
    withoutName.onebot.push(mention('在吗', { messageId: 21 }));
    // 两个实例都要等到「消息已投递」：下面比的是系统小节 + 这轮的「本轮情境」，
    // 而情境是从收件箱里那条消息的第二个 text block 取的 —— 只等 created[0] 会读到空串。
    const [a, b] = await until(
      () => withName.host.list.created[0]?.inbox.length >= 1 && withoutName.host.list.created[0]?.inbox.length >= 1
        ? [withName.host.list.created[0], withoutName.host.list.created[0]]
        : undefined,
      'both group Agents',
    );
    assert.equal(
      promptText(withoutName.host, 'qq-bridge:channel'),
      promptText(withName.host, 'qq-bridge:channel'),
      '群名查不到 / 查得到，系统小节必须逐字一致',
    );
    // 查得到时有这一行；查不到时连空壳都不写（免得模型以为这个群没有名字）。
    assert.ok(turnContextText(a).includes('这个群叫「示例群」'), turnContextText(a));
    assert.ok(!turnContextText(b).includes('这个群叫'), turnContextText(b));
  } finally {
    await withName.onebot.close();
    await withoutName.onebot.close();
  }
});


// 用例十九：拆句与打字延迟的纯函数（时间相关的行为在这里精确验证，避免集成测试抖动）。
test('splitBurst and typingDelayMs behave as documented', () => {
  // 短文本不拆。
  assert.deepEqual(splitBurst('在的', 60, 3), ['在的']);
  // 空文本得到空数组。
  assert.deepEqual(splitBurst('   ', 60, 3), []);
  // 在句末标点处断句，而不是硬切。
  assert.deepEqual(splitBurst('a。b。c。', 4, 3), ['a。b。', 'c。']);
  // 没有任何标点时按长度硬切。
  assert.deepEqual(splitBurst('abcdefghij', 4, 3), ['abcd', 'efgh', 'ij']);
  // 超过 maxParts 的余量并进最后一条（宁可长一点，也不刷屏）。
  assert.deepEqual(splitBurst('一。二。三。四。五。', 4, 2), ['一。二。', '三。四。五。']);
  // maxChars 非正数 = 不拆。
  assert.deepEqual(splitBurst('一。二。三。', 0, 3), ['一。二。三。']);
  // 换行是消息边界：一行一条，不再塞进同一条里换行；空行不算消息。
  assert.deepEqual(splitBurst('在的\n刚吃完\n你呢', 60, 3), ['在的', '刚吃完', '你呢']);
  assert.deepEqual(splitBurst('一\n\n二\n', 60, 3), ['一', '二']);
  // 每一行各自按长度拆：短行不并回同一条，长行才继续拆。
  assert.deepEqual(splitBurst('一。\n二。三。四。', 4, 2), ['一。', '二。三。', '四。']);
  // maxChars = 0 只关掉「长句自动拆」，换行照样分条。
  assert.deepEqual(splitBurst('a\nb', 0, 3), ['a', 'b']);
  // maxMessages：整轮回复的总条数上限。默认 0 = 不限（上面那些用例就是这个行为）。
  // 同一行内部并条是「接回原文」，不留空格；跨行并条补一个空格，不能把两句粘成一个词。
  assert.deepEqual(splitBurst('a。b。c。', 4, 3, 1), ['a。b。c。']);
  assert.deepEqual(splitBurst('a。b。c。', 4, 3, 2), ['a。b。', 'c。']);
  assert.deepEqual(splitBurst('在的\n刚吃完\n你呢', 60, 3, 1), ['在的 刚吃完 你呢']);
  assert.deepEqual(splitBurst('在的\n刚吃完', 60, 3, 1), ['在的 刚吃完']);
  // 额度内不并：一条就够时原样返回。
  assert.deepEqual(splitBurst('在的', 60, 3, 1), ['在的']);
  // 空文本仍然是空数组。
  assert.deepEqual(splitBurst('   ', 60, 3, 1), []);

  const base = { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 60000, jitter: 0 };
  // 打字时间 = 字数 / 速度。
  assert.equal(typingDelayMs(100, base), 10000);
  // 下限与上限都生效。
  assert.equal(typingDelayMs(1, { ...base, minDelayMs: 300 }), 300);
  assert.equal(typingDelayMs(100, { ...base, maxDelayMs: 2000 }), 2000);
  // baseMs 叠加在打字时间之上（「读消息」那一段）。
  assert.equal(typingDelayMs(10, { ...base, baseMs: 500 }), 1500);
  // 抖动：random()=1 时上浮 jitter 比例，random()=0 时下浮同样的比例。
  const jittered = { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 60000, jitter: 0.5, baseMs: 1000 };
  assert.equal(typingDelayMs(10, jittered, () => 1), 3000);
  assert.equal(typingDelayMs(10, jittered, () => 0), 1000);
  // 测试/关闭延迟的写法：上下限都为 0 时恒为 0。
  assert.equal(typingDelayMs(500, { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 0, jitter: 0.9 }, () => 1), 0);
});


// 用例十九之二：复读候选的纯函数 —— 只有整条都是文字时才拿得到原文。
test('repeatableText only accepts messages made of plain text', () => {
  // 文字段拼起来就是原文（不 trim，交给调用方决定怎么归一化）。
  assert.equal(repeatableText([{ type: 'text', data: { text: '  6 ' } }]), '  6 ');
  assert.equal(repeatableText([{ type: 'text', data: { text: '草' } }, { type: 'text', data: { text: '死了' } }]), '草死了');
  // 空数组拿到空串（调用方按「正文为空」丢掉）。
  assert.equal(repeatableText([]), '');
  // 图 / 表情 / @ / 引用 / 卡片：只要掺了一段就不复读。
  assert.equal(repeatableText([{ type: 'text', data: { text: '6' } }, { type: 'image', data: {} }]), undefined);
  assert.equal(repeatableText([{ type: 'face', data: { id: '13' } }]), undefined);
  assert.equal(repeatableText([{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: '你好' } }]), undefined);
  assert.equal(repeatableText([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '6' } }]), undefined);
  assert.equal(repeatableText([{ type: 'json', data: { data: '{}' } }]), undefined);
  // CQ 码字符串：看不出里面藏了什么，含 [CQ: 就放弃；普通句子照收。
  assert.equal(repeatableText('6'), '6');
  assert.equal(repeatableText('[CQ:image,file=x.jpg]'), undefined);
  // 不是消息段数组（字段缺失、上报格式不认识）时什么都不复读。
  assert.equal(repeatableText(undefined), undefined);
  assert.equal(repeatableText({ type: 'text', data: { text: '6' } }), undefined);
});


// 用例十九之三：入站段「是不是表情」只认结构字段 —— 复读要不要按大表情发的判据。
test('isStickerSegment only trusts structural fields', () => {
  // 收藏表情 / 大表情：NapCat 把 QQ 的 picSubType 原样放进 sub_type（非 0 就是表情）。
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 1 } }), true);
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 2 } }), true);
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: '1' } }), true);
  // 商城表情：NapCat 上报时折成 image 段 + emoji_id（没有 sub_type）。
  assert.equal(isStickerSegment({ type: 'image', data: { emoji_id: '42' } }), true);
  // mface 段本身就是商城表情。
  assert.equal(isStickerSegment({ type: 'mface', data: { emoji_id: '42' } }), true);
  // 普通图片（0）与别的段一律不是表情；字段缺失也不能猜成表情。
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 0 } }), false);
  assert.equal(isStickerSegment({ type: 'image', data: {} }), false);
  assert.equal(isStickerSegment({ type: 'image' }), false);
  assert.equal(isStickerSegment({ type: 'face', data: { id: '13' } }), false);
  assert.equal(isStickerSegment(undefined), false);
});


// 用例十九之四：被回复的那条「是不是只有表情」—— 回复它时不挂引用的判据。
test('isEmojiOnlyMessage trusts structural fields and requires the absence of text', () => {
  // 只有表情：表情包 / 商城表情 / 系统表情，都算。
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { sub_type: 1 } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { emoji_id: '42' } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'mface', data: { emoji_id: '42' } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'face', data: { id: '13' } }]), true);
  // @ / reply 段是元信息，不影响「有没有字」的判断：@ 完发一张表情仍然只是表情。
  assert.equal(isEmojiOnlyMessage([
    { type: 'at', data: { qq: '100000002' } },
    { type: 'face', data: { id: '13' } },
  ]), true);
  assert.equal(isEmojiOnlyMessage([
    { type: 'reply', data: { id: '9' } },
    { type: 'image', data: { sub_type: 1 } },
  ]), true);
  // 带文字的就不算：文字才是可以「接」的话头，引用它是有意义的。
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '笑死' } }, { type: 'face', data: { id: '13' } }]), false);
  // 纯空白文字不算「有字」：空白不是可以接的话头。
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '   ' } }, { type: 'face', data: { id: '13' } }]), true);
  // 普通图片 / 语音 / 纯文字 / 字符串形态：都不是「只有表情」。
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { sub_type: 0 } }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: {} }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '[CQ:face,id=13]' } }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '在吗' } }]), false);
  assert.equal(isEmojiOnlyMessage('[CQ:face,id=13]'), false);
  assert.equal(isEmojiOnlyMessage([]), false);
  assert.equal(isEmojiOnlyMessage(undefined), false);
});
