/**
 * 集成测试分册：合并转发（forward）的展开。
 *
 * 夹具在 `test/harness.mjs`；本文件只放这一个主题，可单独跑：
 * `node --test test/bridge-forward.test.mjs`。
 *
 * 三条路径都要覆盖：
 *   - NapCat 默认内联内容（`data.content`）→ 不发 API、直接展开；
 *   - 只有 `data.id` → 走一次 `get_forward_msg`；
 *   - 取不到 / 关掉开关 → 保留 `[合并转发 N 条]` 占位符，消息照常投递。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { SELF_ID, boot, cleanupBoots, groupMessage, privateMessageWithReply, untilInbox } from './harness.mjs';

after(async () => { await cleanupBoots(); });

/** 一条转发的子消息（NapCat 内联内容的形状）。 */
function node(card, text) {
  return { sender: { card, nickname: `${card}-nick`, user_id: 100000003 }, message: [{ type: 'text', data: { text } }] };
}

/** 「@ 了机器人，同时转发了一段聊天记录」；`content` 不传就只留 id。 */
function mentionWithForward(content, { messageId = 7100, id = 'forward-1', card = 'kaguya' } = {}) {
  const data = { id };
  if (content !== undefined) data.content = content;
  return groupMessage(
    [
      { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
      { type: 'forward', data },
    ],
    { messageId, card },
  );
}

test('内联的合并转发会被展开成「谁: 什么」，不发 get_forward_msg', async () => {
  const { onebot, host } = await boot({}, {}, {
    getForward: async () => {
      throw new Error('inline content should not need get_forward_msg');
    },
  });
  onebot.push(mentionWithForward([node('kaguya', '你看这个'), node('tester', '看了')]));
  const agent = await untilInbox(host, 1, 'the forwarded message to reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, '[合并转发 2 条]\nkaguya: 你看这个\ntester: 看了');
  assert.equal(onebot.calls.filter((call) => call.action === 'get_forward_msg').length, 0);
});

test('只有 id 的转发会调一次 get_forward_msg，参数用 id', async () => {
  const seen = [];
  const { onebot, host } = await boot({}, {}, {
    getForward: async (params) => {
      seen.push(params);
      return { messages: [node('kaguya', '取回来的')] };
    },
  });
  onebot.push(mentionWithForward(undefined));
  const agent = await untilInbox(host, 1, 'the forwarded message to reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, '[合并转发 1 条]\nkaguya: 取回来的');
  assert.deepEqual(seen, [{ id: 'forward-1' }]);
});

test('取不到转发内容时保留占位符，消息照常投递', async () => {
  const { onebot, host } = await boot({}, {}, {
    getForward: async () => {
      throw new Error('message expired');
    },
  });
  onebot.push(mentionWithForward(undefined));
  const agent = await untilInbox(host, 1, 'the message to still reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, '[合并转发]');
});

test('forwardRead: false 只留占位符', async () => {
  const { onebot, host } = await boot({ forwardRead: false }, {}, {
    getForward: async () => {
      throw new Error('forwardRead is off, get_forward_msg must not be called');
    },
  });
  onebot.push(mentionWithForward([node('kaguya', '不该出现的内容')]));
  const agent = await untilInbox(host, 1, 'the message to reach the Agent');
  const text = agent.inbox[0].content[0].text;
  assert.equal(text, '[合并转发 1 条]');
  assert.ok(!text.includes('不该出现的内容'));
});

test('forwardMaxNodes 只展开前几条，剩下的写成「还有 N 条」', async () => {
  const { onebot, host } = await boot({ forwardMaxNodes: 1 });
  onebot.push(mentionWithForward([node('kaguya', '第一条'), node('tester', '第二条')]));
  const agent = await untilInbox(host, 1, 'the forwarded message to reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, '[合并转发 2 条]\nkaguya: 第一条\n…（还有 1 条没展开）');
});

test('嵌套转发默认只展开最外层，forwardMaxDepth: 2 才往下', async () => {
  const inner = node('inner', '嵌套内容');
  const outer = { sender: { card: 'outer' }, message: [{ type: 'forward', data: { id: 'inner-1', content: [inner] } }] };
  const shallow = await boot();
  shallow.onebot.push(mentionWithForward([outer]));
  const first = await untilInbox(shallow.host, 1, 'the outer forward to reach the Agent');
  // 默认 depth=1：内层仍是占位符（没有 `inner: 嵌套内容`）。
  assert.match(first.inbox[0].content[0].text, /^\[合并转发 1 条\]\nouter: \[合并转发 1 条\]$/);

  const deep = await boot({ forwardMaxDepth: 2 });
  deep.onebot.push(mentionWithForward([outer]));
  const second = await untilInbox(deep.host, 1, 'the nested forward to reach the Agent');
  assert.equal(
    second.inbox[0].content[0].text,
    '[合并转发 1 条]\nouter: [合并转发 1 条]\n  inner: 嵌套内容\n  [/合并转发]',
  );
});

test('被引用的那条如果是转发，也会在引用前缀里展开', async () => {
  const { onebot, host } = await boot({}, {}, {
    getMsg: async () => ({
      sender: { nickname: 'quoted' },
      message: [{ type: 'forward', data: { id: 'q-1', content: [node('kaguya', '引用里的内容')] } }],
    }),
  });
  onebot.push(privateMessageWithReply('这啥', 42));
  const agent = await untilInbox(host, 1, 'the quoted message to reach the Agent');
  const text = agent.inbox[0].content[0].text;
  assert.match(text, /^（引用 quoted: \[合并转发 1 条\] kaguya: 引用里的内容）/);
  assert.match(text, /这啥/);
});

test('三层嵌套：每层缩进两格，嵌套块带 [/合并转发] 结束标记', async () => {
  const level3 = [
    { sender: { card: 'l3a' }, message: [{ type: 'text', data: { text: '第三层第一句' } }] },
    { sender: { card: 'l3b' }, message: [{ type: 'text', data: { text: '第三层第二句' } }] },
  ];
  const level2 = [
    {
      sender: { card: 'l2a' },
      message: [
        { type: 'text', data: { text: '第二层A说：' } },
        { type: 'forward', data: { id: 'f3', content: level3 } },
      ],
    },
    { sender: { card: 'l2b' }, message: [{ type: 'text', data: { text: '第二层B收尾' } }] },
  ];
  const level1 = [
    {
      sender: { card: 'l1a' },
      message: [
        { type: 'text', data: { text: '最外层A说：' } },
        { type: 'forward', data: { id: 'f2', content: level2 } },
      ],
    },
    { sender: { card: 'l1b' }, message: [{ type: 'text', data: { text: '最外层B收尾' } }] },
  ];

  const { onebot, host } = await boot({ forwardMaxDepth: 3 });
  onebot.push(mentionWithForward(level1));
  const agent = await untilInbox(host, 1, 'the deeply nested forward to reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, [
    '[合并转发 2 条]',
    'l1a: 最外层A说：',
    '  [合并转发 2 条]',
    '  l2a: 第二层A说：',
    '    [合并转发 2 条]',
    '    l3a: 第三层第一句',
    '    l3b: 第三层第二句',
    '    [/合并转发]',
    '  l2b: 第二层B收尾',
    '  [/合并转发]',
    'l1b: 最外层B收尾',
  ].join('\n'));
});

test('一批两条消息时，转发块保留多行并缩进到发言人下面', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 80 });
  onebot.push(mentionWithForward([node('kaguya', '你看这个'), node('tester', '笑死')], { messageId: 1, card: 'a' }));
  onebot.push(groupMessage(
    [
      { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
      { type: 'text', data: { text: '还有我' } },
    ],
    { messageId: 2, userId: 100000004, card: 'b' },
  ));
  const agent = await untilInbox(host, 1, 'the batched messages to reach the Agent');
  assert.equal(agent.inbox[0].content[0].text, [
    '（下面 2 条是几乎同时到的，a、b 都在跟你说话）',
    'a: [合并转发 2 条]',
    '  kaguya: 你看这个',
    '  tester: 笑死',
    'b: 还有我',
  ].join('\n'));
});

test('转发块前后还有文字时，块单独成段，不跟正文粘在同一行', async () => {
  const { onebot, host } = await boot();
  onebot.push(groupMessage(
    [
      { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
      { type: 'text', data: { text: '看这个' } },
      { type: 'forward', data: { id: 'f', content: [node('kaguya', '内容')] } },
      { type: 'text', data: { text: '怎么样' } },
    ],
    { messageId: 7200 },
  ));
  const agent = await untilInbox(host, 1, 'the message with text around the forward');
  assert.equal(agent.inbox[0].content[0].text, [
    '看这个',
    '[合并转发 1 条]',
    'kaguya: 内容',
    '怎么样',
  ].join('\n'));
});
