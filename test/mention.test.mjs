/**
 * `mention.js` 的单元测试：`[[@昵称]]` → OneBot at 段。
 *
 * 这里钉的是**失败方向**而不是实现：认不出来必须丢掉整段标记（绝不能把 `[[@…]]`
 * 原样发进群里）、畸形标记必须落回普通文本（绝不能吃掉后面半句话）、
 * `@全体成员` 只在允许的会话里才解析得出来。
 *
 * 运行：node --test test/mention.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMentionResolver, hasMentionMarker, isAllMention, mentionResolverFrom, mentionSegments } from '../mention.js';

/** 一个「名单 → 解析函数」的快捷方式，模拟 index.js 里的会话参与者。 */
const resolve = (entries) => mentionResolverFrom(entries);

/** 便捷断言：整段正文 → 段数组。 */
const seg = (text, lookup) => mentionSegments(text, lookup);

test('mentionSegments：没有标记时原样一段文本，不 trim 正文', () => {
  assert.deepEqual(seg('你好呀', resolve([])), [{ type: 'text', data: { text: '你好呀' } }]);
  // 前导空格留给拆条那一层（splitBurst 按空格断句），这里不动它。
  assert.deepEqual(seg(' 你来说', resolve([])), [{ type: 'text', data: { text: ' 你来说' } }]);
  assert.deepEqual(seg('   ', resolve([])), []);
});

test('mentionSegments：标记换成 at 段，位置与顺序照原文', () => {
  const lookup = resolve([{ name: 'kaguya', id: '100000003' }]);
  assert.deepEqual(seg('[[@kaguya]] 你来说', lookup), [
    { type: 'at', data: { qq: '100000003' } },
    { type: 'text', data: { text: ' 你来说' } },
  ]);
  assert.deepEqual(seg('看这个 [[@kaguya]] 怎么样', lookup), [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'at', data: { qq: '100000003' } },
    { type: 'text', data: { text: ' 怎么样' } },
  ]);
  // 只 @ 一个人、一个字都不说：整条就只有一个 at 段。
  assert.deepEqual(seg('[[@kaguya]]', lookup), [{ type: 'at', data: { qq: '100000003' } }]);
  // 一条里 @ 两个人。
  const two = resolve([
    { name: 'kaguya', id: '100000003' },
    { name: 'iroha', id: '3333333333' },
  ]);
  assert.deepEqual(seg('[[@kaguya]] [[@iroha]] 你俩', two), [
    { type: 'at', data: { qq: '100000003' } },
    { type: 'text', data: { text: ' ' } },
    { type: 'at', data: { qq: '3333333333' } },
    { type: 'text', data: { text: ' 你俩' } },
  ]);
});

test('mentionSegments：认不出来的名字整个丢掉，而不是原样发出去', () => {
  const lookup = resolve([{ name: 'kaguya', id: '100000003' }]);
  // 乱编的名字：标记消失，其余正文一个字不少。
  assert.deepEqual(seg('[[@不存在的人]] 在吗', lookup), [{ type: 'text', data: { text: ' 在吗' } }]);
  // 前面还有正文时，正文不能被标记的消失带走（这里曾经把「在吗 」整段吞掉）。
  assert.deepEqual(seg('在吗 [[@不存在的人]] 说句话', lookup), [{ type: 'text', data: { text: '在吗  说句话' } }]);
  // 一个都不认识、整条只有标记：什么都不发（调用方会按空数组处理）。
  assert.deepEqual(seg('[[@查无此人]]', lookup), []);
  // 没有名单（比如根本不知道会话里有谁）时同样退化成纯文本。
  assert.deepEqual(seg('[[@kaguya]] 在', resolve([])), [{ type: 'text', data: { text: ' 在' } }]);
});

test('mentionSegments：很长但没有标记的正文按探测门槛截断；**有标记就一个字都不丢**', () => {
  const lookup = resolve([{ name: 'kaguya', id: '100000003' }]);
  // 没有标记：超过门槛的部分不再往下传（这种长度只可能出自畸形输入）。
  const plain = '字'.repeat(5000);
  assert.deepEqual(seg(plain, lookup), [{ type: 'text', data: { text: '字'.repeat(4000) } }]);
  // 有标记：整段解析，标记**后面**的长正文一个字都不能少 —— 曾经在这里按门槛切过一刀，
  // 结果是一条超长回复在第一个 @ 那里被悄悄截掉了尾巴。
  const long = `[[@kaguya]] ${'字'.repeat(5000)}`;
  const parsed = seg(long, lookup);
  assert.equal(parsed[0].type, 'at');
  assert.equal(parsed[1].data.text.length, 5001);
});

test('mentionSegments：畸形标记落回普通文本，绝不吃掉后面的正文', () => {
  const lookup = resolve([{ name: 'kaguya', id: '100000003' }]);
  // 没闭合：原样发出去（写错的字该露出来，好排查）。
  assert.deepEqual(seg('[[@kaguya 在吗', lookup), [{ type: 'text', data: { text: '[[@kaguya 在吗' } }]);
  assert.deepEqual(seg('[[@kaguya] 在吗', lookup), [{ type: 'text', data: { text: '[[@kaguya] 在吗' } }]);
  // 空名字：不算标记。
  assert.deepEqual(seg('[[@]] 在吗', lookup), [{ type: 'text', data: { text: '[[@]] 在吗' } }]);
  // 换行会终止昵称：这一行是畸形标记，下一行的正文照旧。
  assert.deepEqual(seg('[[@kaguya\n你好', lookup), [{ type: 'text', data: { text: '[[@kaguya\n你好' } }]);
  // 已经是普通文本里的方括号（表情包标记、代码）不受影响。
  assert.deepEqual(seg('[[图片: .qq-stickers/笑死.gif]]', lookup), [{ type: 'text', data: { text: '[[图片: .qq-stickers/笑死.gif]]' } }]);
});

test('mentionSegments：名字两端空白被吃掉，中间的空格算名字的一部分', () => {
  const lookup = resolve([{ name: 'kaguya', id: '100000003' }]);
  assert.deepEqual(seg('[[@ kaguya ]] 在吗', lookup), [
    { type: 'at', data: { qq: '100000003' } },
    { type: 'text', data: { text: ' 在吗' } },
  ]);
  // 群名片里带空格是真实存在的（「小 可」），所以名字要按整串精确匹配。
  const spaced = resolve([{ name: '小 可', id: '100000009' }]);
  assert.deepEqual(seg('[[@小 可]]', spaced), [{ type: 'at', data: { qq: '100000009' } }]);
});

test('mentionResolverFrom：精确优先、再忽略大小写；同名不同人保留先登记的那个', () => {
  const lookup = resolve([
    { name: 'Kaguya', id: '1' },
    { name: 'kaguya', id: '2' },
    { name: 'iroha', id: '3' },
  ]);
  assert.equal(lookup('Kaguya'), '1');
  assert.equal(lookup('kaguya'), '2');
  // 两种写法都在名单里时精确命中；只有一种时忽略大小写也能命中。
  assert.equal(lookup('IROHA'), '3');
  assert.equal(lookup(''), undefined);
  assert.equal(lookup('nobody'), undefined);
  // 名单里的空白项（环境上下文里没取到昵称的那条）直接跳过，不会变成一个空名字。
  assert.equal(resolve([{ name: '  ', id: '9' }, { name: 'x', id: '' }])(''), undefined);
});

test('hasMentionMarker：只用来决定「要不要走 @ 解析」', () => {
  assert.equal(hasMentionMarker('[[@kaguya]] 在吗'), true);
  assert.equal(hasMentionMarker('[[@全体成员]]'), true);
  assert.equal(hasMentionMarker('[[图片: a.png]]'), false);
  assert.equal(hasMentionMarker('普通文本'), false);
  assert.equal(hasMentionMarker(undefined), false);
});

test('isAllMention：认 all 与「全体成员」两种写法', () => {
  assert.equal(isAllMention('all'), true);
  assert.equal(isAllMention('ALL'), true);
  assert.equal(isAllMention('全体成员'), true);
  assert.equal(isAllMention(' kaguya '), false);
});

test('buildMentionResolver：全体成员只在群聊里解析得出来，名单按会话隔离', () => {
  const group = { type: 'group', participants: [{ name: 'kaguya', id: '100000003' }] };
  const privateChat = { type: 'private', participants: [{ name: 'iroha', id: '100000002' }] };
  assert.equal(buildMentionResolver(group)('全体成员'), 'all');
  assert.equal(buildMentionResolver(group)('all'), 'all');
  assert.equal(buildMentionResolver(group)('kaguya'), '100000003');
  // 私聊里没有「全体成员」这回事。
  assert.equal(buildMentionResolver(privateChat)('全体成员'), undefined);
  assert.equal(buildMentionResolver(privateChat)('iroha'), '100000002');
  // 名单是按会话隔离的：另一个会话里的人在这个会话里 @ 不到。
  assert.equal(buildMentionResolver(privateChat)('kaguya'), undefined);
  // 没有 participants（记录还没登记过谁说过话）时谁都不认识，但不会抛。
  assert.equal(buildMentionResolver({ type: 'group' })('kaguya'), undefined);
  assert.equal(buildMentionResolver(undefined)('kaguya'), undefined);
});
