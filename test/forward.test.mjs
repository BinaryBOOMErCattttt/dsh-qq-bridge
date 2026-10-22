/**
 * `forward.js` 的单元测试：合并转发的节点归一与**有界**展开。
 *
 * 这里钉的主要是三件容易「看起来没坏、实际把人坑了」的事：
 *   1. 三种节点形状（完整消息对象 / `node` 段 / 字符串 message）都要认；
 *   2. 条数、字数、认不出的节点都要算进「还剩多少条」，不能重复计数；
 *   3. 没有内联内容时才发 `get_forward_msg`，取不到就返回 undefined（由调用方保留占位符）。
 *
 * 运行：node --test test/forward.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expandForward,
  fetchForwardNodes,
  forwardId,
  forwardNode,
  forwardNodes,
  renderForwardNodes,
} from '../forward.js';

/** 一条带群名片与昵称的消息对象（NapCat 内联内容就是这个形状）。 */
function messageObject(card, nickname, text) {
  return {
    sender: { card, nickname, user_id: 100 },
    message: [{ type: 'text', data: { text } }],
  };
}

/** 把节点里的 text 段拼出来，模拟调用方的 renderNode。 */
async function renderNode({ message }) {
  return Array.isArray(message) ? message.map((segment) => segment.data?.text ?? '').join('') : message;
}

test('forwardNodes：只认非空的 content 数组，空数组按「没有内联内容」处理', () => {
  const nodes = [messageObject('kaguya', 'tomori', '你好')];
  assert.deepEqual(forwardNodes({ type: 'forward', data: { content: nodes } }), nodes);
  assert.equal(forwardNodes({ type: 'forward', data: { content: [] } }), undefined);
  assert.equal(forwardNodes({ type: 'forward', data: {} }), undefined);
  assert.equal(forwardNodes({ type: 'forward' }), undefined);
  assert.equal(forwardNodes(undefined), undefined);
});

test('forwardId：字符串与数字都收，其余给空串', () => {
  assert.equal(forwardId({ data: { id: ' abc ' } }), 'abc');
  assert.equal(forwardId({ data: { id: 123 } }), '123');
  assert.equal(forwardId({ data: { id: '' } }), '');
  assert.equal(forwardId({ data: { id: NaN } }), '');
  assert.equal(forwardId({ data: {} }), '');
});

test('forwardNode：完整消息对象、node 段、字符串 message 都能归一', () => {
  // 群名片优先于昵称 —— 与正文里的 `名字:` 是同一个口径。
  assert.deepEqual(
    forwardNode(messageObject('kaguya', 'tomori', '说了句')),
    { name: 'kaguya', message: [{ type: 'text', data: { text: '说了句' } }] },
  );
  // NapCat 的嵌套转发是 `{ type: 'node', data: { nickname, message } }`。
  assert.deepEqual(
    forwardNode({ type: 'node', data: { nickname: 'tester', message: [{ type: 'text', data: { text: '嵌套' } }] } }),
    { name: 'tester', message: [{ type: 'text', data: { text: '嵌套' } }] },
  );
  // 个别实现直接给一段 CQ 码/纯文本。
  assert.deepEqual(forwardNode({ sender: { nickname: 'n' }, message: '纯文本' }), { name: 'n', message: '纯文本' });
  // 只有 QQ 号时退回号码；什么都没有才是「某人」。
  assert.deepEqual(forwardNode({ sender: {}, user_id: 12345, message: [] }), { name: '12345', message: [] });
  assert.deepEqual(forwardNode({ message: [] }), { name: '某人', message: [] });
  // 连 message/content 都没有 → 认不出。
  assert.equal(forwardNode({ sender: { nickname: 'n' } }), undefined);
  assert.equal(forwardNode(null), undefined);
});

test('renderForwardNodes：一条一行「谁: 什么」，换行折成空格', async () => {
  const text = await renderForwardNodes([messageObject('kaguya', 'tomori', '第一行\n第二行'), messageObject('', 'tester', '看了')], {
    renderNode: async ({ message }) => `→ ${message[0].data.text}`,
  });
  assert.equal(text, '[合并转发 2 条]\nkaguya: → 第一行 第二行\ntester: → 看了');
});

test('renderForwardNodes：空正文与认不出的节点都不丢行', async () => {
  const text = await renderForwardNodes(
    [{ sender: { nickname: 'n' }, message: [] }, { nonsense: true }],
    { renderNode: async () => '' },
  );
  // 第二条认不出，但「还有 1 条没展开」必须把它算进去，不能重复成 2 条。
  assert.equal(text, '[合并转发 2 条]\nn: （空消息）\n…（还有 1 条没展开）');
});

test('renderForwardNodes：条数上限与字数上限都会写出「还有 N 条」', async () => {
  const nodes = Array.from({ length: 5 }, (_, index) => messageObject('kaguya', 'tomori', `第${index + 1}句`));
  const capped = await renderForwardNodes(nodes, { renderNode, maxNodes: 2 });
  assert.equal(capped, '[合并转发 5 条]\nkaguya: 第1句\nkaguya: 第2句\n…（还有 3 条没展开）');

  // 字数：每行都很长时，第一行之后就到顶；剩下的全部算「没展开」。
  const longNodes = Array.from({ length: 3 }, (_, index) => messageObject('k', 'n', `${index}${'长'.repeat(80)}`));
  const narrow = await renderForwardNodes(longNodes, { renderNode, maxChars: 80 });
  assert.match(narrow, /^\[合并转发 3 条\]/);
  assert.match(narrow, /还有 \d+ 条没展开）$/);
});

test('renderForwardNodes：没有节点 / 没有 renderNode 时返回 undefined', async () => {
  assert.equal(await renderForwardNodes([], { renderNode }), undefined);
  assert.equal(await renderForwardNodes([messageObject('a', 'b', 'x')], {}), undefined);
});

test('fetchForwardNodes：先试 { id }，失败再试 { message_id }', async () => {
  const seen = [];
  const call = async (action, params) => {
    seen.push({ action, params });
    if (params.id !== undefined) throw new Error('id is not accepted');
    return { messages: [messageObject('a', 'b', 'x')] };
  };
  const nodes = await fetchForwardNodes(call, 'abc');
  assert.equal(nodes.length, 1);
  assert.deepEqual(seen.map((item) => item.params), [{ id: 'abc' }, { message_id: 'abc' }]);
});

test('fetchForwardNodes：返回数组 / { message } 也认；全失败返回 undefined', async () => {
  const asArray = await fetchForwardNodes(async () => [messageObject('a', 'b', 'x')], 'abc');
  assert.equal(asArray.length, 1);
  const asMessage = await fetchForwardNodes(async () => ({ message: [messageObject('a', 'b', 'x')] }), 'abc');
  assert.equal(asMessage.length, 1);
  assert.equal(await fetchForwardNodes(async () => ({ nope: true }), 'abc'), undefined);
  assert.equal(await fetchForwardNodes(async () => { throw new Error('gone'); }, 'abc'), undefined);
  assert.equal(await fetchForwardNodes(async () => [], ''), undefined);
  assert.equal(await fetchForwardNodes(undefined, 'abc'), undefined);
});

test('expandForward：有内联内容时不发请求；没有才去取；node 段直接展开', async () => {
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { messages: [messageObject('fetched', 'n', '取回来的')] };
  };
  const inline = await expandForward(
    { type: 'forward', data: { content: [messageObject('kaguya', 'tomori', '内联的')] } },
    { call, renderNode },
  );
  assert.equal(inline, '[合并转发 1 条]\nkaguya: 内联的');
  assert.equal(calls, 0, '有内联内容就不该发 get_forward_msg');

  const fetched = await expandForward({ type: 'forward', data: { id: 'abc' } }, { call, renderNode });
  assert.equal(fetched, '[合并转发 1 条]\nfetched: 取回来的');
  assert.equal(calls, 1);

  const nested = await expandForward(
    { type: 'node', data: { nickname: 'nested', message: [{ type: 'text', data: { text: '节点' } }] } },
    { call, renderNode },
  );
  assert.equal(nested, '[合并转发 1 条]\nnested: 节点');
  assert.equal(calls, 1, 'node 段不需要再取');

  // 没有内联内容、也没有 id → undefined，调用方保留占位符。
  assert.equal(await expandForward({ type: 'forward', data: {} }, { call, renderNode }), undefined);
  assert.equal(await expandForward({ type: 'forward', data: { id: 'gone' } }, { call: async () => { throw new Error('gone'); }, renderNode }), undefined);
});

test('renderForwardNodes：单条正文太长时保留前半段并加省略号，而不是整条丢掉', async () => {
  const long = messageObject('kaguya', 'tomori', '长'.repeat(200));
  const text = await renderForwardNodes([long], { renderNode, maxChars: 60 });
  assert.match(text, /^\[合并转发 1 条\]\nkaguya: 长+…$/);
  assert.ok(text.length <= 61, `不能明显超过字数上限：${text.length}`);
  assert.ok(!text.includes('还有 1 条没展开'), '被截断的那条已经展示了一部分，不该再算「没展开」');
});

test('renderForwardNodes：multiline 保留换行与缩进，closing 追加结束标记', async () => {
  const nodes = [messageObject('kaguya', 'tomori', '不需要')];
  const renderNode = async () => '第一行\n  缩进两格的第二行';
  // 默认仍是「折成一行」的旧契约。
  assert.equal(
    await renderForwardNodes(nodes, { renderNode }),
    '[合并转发 1 条]\nkaguya: 第一行 缩进两格的第二行',
  );
  // 多行模式保留调用方排好的换行/缩进（嵌套块靠它）。
  assert.equal(
    await renderForwardNodes(nodes, { renderNode, multiline: true }),
    '[合并转发 1 条]\nkaguya: 第一行\n  缩进两格的第二行',
  );
  // 嵌套块要在末尾有明确边界。
  assert.equal(
    await renderForwardNodes(nodes, { renderNode, multiline: true, closing: true }),
    '[合并转发 1 条]\nkaguya: 第一行\n  缩进两格的第二行\n[/合并转发]',
  );
});

test('renderForwardNodes：closing 的结束标记不会被正文字数挤掉', async () => {
  const nodes = [messageObject('k', 'n', '长'.repeat(200))];
  const text = await renderForwardNodes(nodes, {
    renderNode: async () => '长'.repeat(200),
    maxChars: 40,
    multiline: true,
    closing: true,
  });
  assert.ok(text.endsWith('\n[/合并转发]'), text);
  assert.match(text, /…\n\[\/合并转发\]$/);
});
