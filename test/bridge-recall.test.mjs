/**
 * 集成测试分册：撤回（清引用 / 改写 / 补一句 / tombstone）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-recall.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SELF_ID, GROUP_USER_ID, turnContextText, until, untilInbox, mention, completeTurn, sentTexts, groupText, settle, localDateOf, bootRecall, groupRecall, quotedAny, privateRecall, privateMessage } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


test('撤回：tease + 被 @ 的那条还在攒批窗口里 → 这一轮就地改写成调侃', async () => {
  // `replyStyle: quote` 把引用钉在第一条上：没有安全层的话这条回复会带着 reply 段出去。
  // 改写只在 `recallAddressed: answer` 这一档发生；默认是 `drop`（真不回），不存在改写。
  const { onebot, host } = await bootRecall({
    recallMode: 'tease',
    recallAddressed: 'answer',
    batchWindowMs: 400,
    replyStyle: 'quote',
  });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    // 紧接着撤回：这一批还没进模型（还在攒批窗口里）。
    onebot.push(groupRecall({ messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the rewritten turn to be submitted');
    assert.equal(agent.inbox.length, 1, '改写：本来就要开的这一轮，不另开一轮');
    const text = agent.inbox[0].content[0].text;
    assert.match(text, /撤回/);
    assert.match(text, /kaguya/);
    // 正文被整个换掉了：默认不给原文（recallTeaseQuote: false）。
    assert.doesNotMatch(text, /晚上吃啥/);

    completeTurn(host, agent, '撤什么呀，我看见了', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the tease to go out');
    assert.equal(sent[0], '撤什么呀，我看见了');
    assert.equal(quotedAny(onebot), false, '绝不引用一条已经不在的消息');
  } finally {
    await onebot.close();
  }
});


test('撤回：ignore + answer → 照常回答、不引用（它根本没注意到撤回）', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'ignore', recallAddressed: 'answer', batchWindowMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    onebot.push(groupRecall({ messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the addressed turn to be submitted');
    const text = agent.inbox[0].content[0].text;
    // 「假装没看到」最自然的形态：模型看见的还是原问题。
    assert.match(text, /晚上吃啥/);
    assert.doesNotMatch(text, /撤回/);

    completeTurn(host, agent, '吃火锅', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the reply to go out');
    assert.equal(sent[0], '吃火锅');
    assert.equal(quotedAny(onebot), false, '引用被清掉了，否则这条回复会整条发不出去');
  } finally {
    await onebot.close();
  }
});


test('撤回：ignore + recallAddressed=drop → 被 @ 的那条真不回', async () => {
  // `recallAddressed: drop` 是默认值；这里显式写着，是为了让这条用例自己说明在验哪一档。
  const { onebot, host } = await bootRecall({ recallAddressed: 'drop', batchWindowMs: 400 });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    onebot.push(groupRecall({ messageId: 7000 }));
    // 等到比整个攒批窗口还久：真有东西要投的话早就投了。
    await settle(700);
    assert.equal(host.list.created.length, 0, '撤回 = 当没收到：一个 Agent 都不该被造出来');
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});


test('撤回：tease + turn 在飞 → 只清引用，不补刀', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn to be submitted');
    // 还没 completeTurn：这一轮正在飞（`busyWithTurn` 为真）。
    onebot.push(groupRecall({ messageId: 7000 }));
    await settle(120);

    completeTurn(host, agent, '吃火锅', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the reply to go out');
    assert.equal(sent[0], '吃火锅');
    assert.equal(quotedAny(onebot), false);

    // 只有一条：这一轮的回复本身就是回应，再补一句是连发两条。
    await settle(200);
    assert.equal(agent.inbox.length, 1);
    assert.equal(sentTexts(onebot).length, 1);
  } finally {
    await onebot.close();
  }
});


test('撤回：tease + 已经回过了 → 补一句调侃，不引用、也不带原文', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn to be submitted');
    completeTurn(host, agent, '吃火锅', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the tease turn to be submitted');
    const text = agent.inbox[1].content[0].text;
    assert.match(text, /不是谁发给你的消息/, '必须说清这不是谁在跟它说话');
    assert.match(text, /kaguya/);
    assert.match(text, /你已回过/);
    assert.match(text, /SKIP/, 'nudge 必须给出 SKIP 出口');
    assert.doesNotMatch(text, /晚上吃啥/, '默认不给原文');

    completeTurn(host, agent, '撤得有点晚，我都回了', 2);
    const sent = await until(() => (sentTexts(onebot).length === 2 ? sentTexts(onebot) : undefined), 'the tease to go out');
    assert.equal(sent[1], '撤得有点晚，我都回了');
    // 调侃那一条是**裸文本**（没有段数组）：它不指向任何消息 —— 被撤的那条早就不在了。
    assert.equal(typeof sent[1], 'string');
  } finally {
    await onebot.close();
  }
});


test('撤回：冷却之内的第二次撤回不再补一句（但第一次照样用掉机会）', async () => {
  // 两条消息几乎同时到 → 攒成一轮，于是「两条都已经回过」，冷却成为唯一挡住第二次的东西。
  const { onebot, host } = await bootRecall({ recallMode: 'tease', batchWindowMs: 400, recallCooldownMs: 60000 });
  try {
    onebot.push(mention('第一句', { messageId: 7000 }));
    onebot.push(mention('第二句', { messageId: 7001 }));
    const agent = await untilInbox(host, 1, 'the batched turn');
    assert.equal(agent.inbox.length, 1, '两条攒成一轮');
    completeTurn(host, agent, '好', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the first tease turn');
    // SKIP：一个字都不发，但这次机会照样用掉（先记账再 followup）。
    completeTurn(host, agent, 'SKIP', 2);
    await settle(150);
    assert.equal(sentTexts(onebot).length, 1);

    onebot.push(groupRecall({ messageId: 7001 }));
    await settle(200);
    assert.equal(agent.inbox.length, 2, '冷却期内不补第二句');
  } finally {
    await onebot.close();
  }
});


test('撤回：当天次数到上限就不再补一句（0 = 不限）', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', batchWindowMs: 400, recallDailyMax: 1 });
  try {
    onebot.push(mention('第一句', { messageId: 7000 }));
    onebot.push(mention('第二句', { messageId: 7001 }));
    const agent = await untilInbox(host, 1, 'the batched turn');
    completeTurn(host, agent, '好', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the only tease of the day');
    completeTurn(host, agent, 'SKIP', 2);
    await settle(150);

    onebot.push(groupRecall({ messageId: 7001 }));
    await settle(200);
    assert.equal(agent.inbox.length, 2, 'recallDailyMax: 1 → 第二条不再开口');
  } finally {
    await onebot.close();
  }
});


test('撤回：管理员代撤、自己发的话被撤、太久以前的撤回都不调侃', async () => {
  // ① 管理员替别人撤了话：调侃他等于公开处刑，而且对象错了。
  const operator = await bootRecall({ recallMode: 'tease' });
  try {
    operator.onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(operator.host, 1, 'the turn');
    completeTurn(operator.host, agent, '吃火锅', 1);
    await until(() => sentTexts(operator.onebot).length === 1, 'the reply to go out');
    operator.onebot.push(groupRecall({ messageId: 7000, operatorId: 10002 }));
    await settle(200);
    assert.equal(agent.inbox.length, 1, 'operator_id ≠ user_id 时不调侃');
  } finally {
    await operator.onebot.close();
  }

  // ② 机器人自己发的话被撤：那是另一件事（多半也是管理员操作），连账都不记。
  const own = await bootRecall({ recallMode: 'tease' });
  try {
    own.onebot.push(groupText('在的', { messageId: 7005, userId: SELF_ID, name: '小助手' }));
    own.onebot.push(groupRecall({ messageId: 7005, userId: SELF_ID }));
    await settle(200);
    assert.equal(own.host.list.created.length, 0, '自己的消息不进「最近看见过」，所以没有可调侃的对象');
  } finally {
    await own.onebot.close();
  }

  // ③ 太久以前的撤回：`recallMaxAgeMs` 之内才算数。
  const stale = await bootRecall({ recallMode: 'tease', recallMaxAgeMs: 100 });
  try {
    stale.onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(stale.host, 1, 'the turn');
    completeTurn(stale.host, agent, '吃火锅', 1);
    await until(() => sentTexts(stale.onebot).length === 1, 'the reply to go out');
    await settle(250);
    stale.onebot.push(groupRecall({ messageId: 7000 }));
    await settle(200);
    assert.equal(agent.inbox.length, 1, '超时的撤回不再提');
  } finally {
    await stale.onebot.close();
  }
});


test('撤回：ignore 会把群聊环境上下文里那条也摘掉', async () => {
  const { onebot, host } = await bootRecall();
  try {
    onebot.push(groupText('别记我说过这句', { messageId: 7002, userId: 10001, card: 'soyo' }));
    onebot.push(groupText('这句留着', { messageId: 7003, userId: 10001, card: 'soyo' }));
    onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    onebot.push(mention('刚才说啥了', { messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the addressed turn');
    const prompt = turnContextText(agent);
    // 「假装没看到」必须连环境上下文也一起删：不然它下次被 @ 时又读到那句。
    assert.doesNotMatch(prompt, /别记我说过这句/);
    assert.match(prompt, /这句留着/, '没被撤回的那条照旧在上下文里');
  } finally {
    await onebot.close();
  }
});


test('撤回：tease + scope all 会为别人的撤回开口，to-me 不会', async () => {
  // ① all：群里别人的闲聊被撤回 → 主动开一轮调侃。
  const all = await bootRecall({ recallMode: 'tease', recallScope: 'all' });
  try {
    // 先让它在这个群里说过话：没有会话记录就不主动开口（与主动说话同一条纪律）。
    all.onebot.push(mention('在吗', { messageId: 7000 }));
    const agent = await untilInbox(all.host, 1, 'the first turn');
    completeTurn(all.host, agent, '在的', 1);
    await until(() => sentTexts(all.onebot).length === 1, 'the first reply');

    all.onebot.push(groupText('他们聊他们的', { messageId: 7002, userId: 10001, card: 'soyo' }));
    all.onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    await untilInbox(all.host, 2, 'the ambient tease');
    const text = agent.inbox[1].content[0].text;
    assert.match(text, /不是谁发给你的消息/);
    assert.match(text, /soyo/);
    assert.match(text, /你没回过/);
  } finally {
    await all.onebot.close();
  }

  // ② to-me：同样的序列，但它不该为别人的撤回开口。
  const toMe = await bootRecall({ recallMode: 'tease', recallScope: 'to-me' });
  try {
    toMe.onebot.push(mention('在吗', { messageId: 7000 }));
    const agent = await untilInbox(toMe.host, 1, 'the first turn');
    completeTurn(toMe.host, agent, '在的', 1);
    await until(() => sentTexts(toMe.onebot).length === 1, 'the first reply');

    toMe.onebot.push(groupText('他们聊他们的', { messageId: 7002, userId: 10001, card: 'soyo' }));
    toMe.onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    await settle(250);
    assert.equal(agent.inbox.length, 1, 'to-me：别人的撤回不开口');
  } finally {
    await toMe.onebot.close();
  }
});


test('撤回：转录里追加一行 tombstone，原文仍在、不重复', async () => {
  const { onebot, host, cwd } = await bootRecall({ recallMode: 'tease' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn');
    completeTurn(host, agent, '吃火锅', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');
    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the tease turn');

    // 转录是后台串行写盘的，所以等它落地再看内容。
    const logFile = join(cwd, '.qq-memory', 'conversations', 'group-100000001', 'log', `${localDateOf()}.jsonl`);
    const lines = await until(async () => {
      if (!existsSync(logFile)) return undefined;
      const parsed = (await readFile(logFile, 'utf8')).trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
      return parsed.some((line) => line.kind === 'recall') ? parsed : undefined;
    }, 'the recall tombstone to be written');

    const tombstone = lines.find((line) => line.kind === 'recall');
    assert.equal(tombstone.recall, '7000');
    assert.equal(tombstone.user, String(GROUP_USER_ID));
    assert.equal(tombstone.addressed, true);
    // 追加而不是删行：原文还在，而且只有那一行。
    assert.equal(lines.filter((line) => line.text === '晚上吃啥').length, 1, '原文仍在、不重复');
  } finally {
    await onebot.close();
  }
});


test('撤回：私聊关掉 recallPrivate 时照常回答，默认则真不回', async () => {
  // ① 显式关掉（recallPrivate: false）：撤回被无视，那条照常投给模型 —— 这是「为什么我撤回了
  //    它还在回」的原始形态。默认值现在是「处理私聊撤回」，所以这里必须显式关。
  const defaults = await bootRecall({ batchWindowMs: 400, recallPrivate: false });
  try {
    defaults.onebot.push({ ...privateMessage('在吗'), message_id: 7100 });
    defaults.onebot.push(privateRecall({ messageId: 7100 }));
    await untilInbox(defaults.host, 1, 'the recall to be ignored in a private chat');
    assert.equal(defaults.host.list.created.length, 1, '默认不处理私聊撤回：照常回答');
  } finally {
    await defaults.onebot.close();
  }

  // ② 默认（recallPrivate: true + recallAddressed: drop）：撤回的那条从待回批次里摘掉，真的不回。
  const silent = await bootRecall({ batchWindowMs: 400 });
  try {
    silent.onebot.push({ ...privateMessage('在吗'), message_id: 7101 });
    silent.onebot.push(privateRecall({ messageId: 7101 }));
    // 等到比整个攒批窗口还久：真有东西要投的话早就投了。
    await settle(700);
    assert.equal(silent.host.list.created.length, 0, 'drop 之后一个 Agent 都不该被造出来');
    assert.deepEqual(sentTexts(silent.onebot, 'send_private_msg'), []);
  } finally {
    await silent.onebot.close();
  }
});
