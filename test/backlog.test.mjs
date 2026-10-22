/**
 * `backlog.js` 的契约测试。
 *
 * 这一波「迟到的消息」唯一的判断题都在这层纯函数里（留几条、怎么写相对时间、省略行怎么
 * 说），`index.js` 只负责把会话记录凑成入参。把它测住，等于把「长任务期间被 @」那条
 * 行为钉住 —— 不需要启动机器人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionBacklog, relativeTime, renderBacklog } from '../backlog.js';

/** 一条 `name / body / at` 的积压消息。 */
function entry(name, body, at) {
  return { name, body, at };
}

/** 造 `count` 条一分钟一条的消息（越靠后越新）。 */
function wave(count, now = 1_000_000_000) {
  return Array.from({ length: count }, (_, index) => entry(`u${index}`, `第 ${index} 句`, now - (count - index) * 60_000));
}

test('relativeTime：粗粒度说「多旧」，回拨与非法值都算刚刚', () => {
  assert.equal(relativeTime(0), '刚刚');
  assert.equal(relativeTime(14_999), '刚刚');
  assert.equal(relativeTime(15_000), '15 秒前');
  assert.equal(relativeTime(59_000), '59 秒前');
  assert.equal(relativeTime(60_000), '1 分钟前');
  assert.equal(relativeTime(8 * 60_000 + 30_000), '8 分钟前');
  assert.equal(relativeTime(59 * 60_000), '59 分钟前');
  assert.equal(relativeTime(60 * 60_000), '1 小时前');
  assert.equal(relativeTime(25 * 60 * 60_000), '1 天前');
  // 时钟回拨、缺字段、乱传：宁可说「刚刚」，也不能写出「-3 秒前」这种东西。
  assert.equal(relativeTime(-5_000), '刚刚');
  assert.equal(relativeTime(Number.NaN), '刚刚');
  assert.equal(relativeTime(undefined), '刚刚');
});

test('partitionBacklog：没超上限时原样保留，omitted 为 0', () => {
  const list = wave(5);
  const { kept, omitted } = partitionBacklog(list, { maxEntries: 20, maxChars: 2000 });
  assert.equal(omitted, 0);
  assert.deepEqual(kept.map((item) => item.name), ['u0', 'u1', 'u2', 'u3', 'u4']);
});

test('partitionBacklog：超条数时保留最早 2 条 + 最近的一截，中间折成省略', () => {
  const list = wave(30);
  const { kept, omitted } = partitionBacklog(list, { maxEntries: 20, maxChars: 1_000_000 });
  assert.equal(kept.length, 20);
  assert.equal(omitted, 10);
  // 最早两条是这波真正的由头，不能因为「只留最近」被丢掉。
  assert.deepEqual(kept.slice(0, 2).map((item) => item.name), ['u0', 'u1']);
  assert.equal(kept.at(-1).name, 'u29');
  // 折掉的是中间那一段（u2..u11），不是最新的一截。
  assert.ok(kept.every((item) => item.name !== 'u5'));
});

test('partitionBacklog：超字数时从最老的一头丢，永远保留最后一条', () => {
  const list = [
    entry('a', 'x'.repeat(100), 1),
    entry('b', 'x'.repeat(100), 2),
    entry('c', 'x'.repeat(100), 3),
    entry('d', 'x'.repeat(100), 4),
    entry('e', 'x'.repeat(100), 5),
  ];
  const { kept, omitted } = partitionBacklog(list, { maxEntries: 20, maxChars: 250 });
  assert.equal(omitted, 3);
  assert.deepEqual(kept.map((item) => item.name), ['b', 'e']);
  assert.equal(kept.at(-1).name, 'e');
});

test('partitionBacklog：条数配成 0 / 1 也至少留「第一条 + 最后一条」', () => {
  const list = wave(4);
  const { kept, omitted } = partitionBacklog(list, { maxEntries: 1, maxChars: 1_000_000 });
  assert.deepEqual(kept.map((item) => item.name), ['u0', 'u3']);
  assert.equal(omitted, 2);
});

test('partitionBacklog：空入参与非数组都安全返回空', () => {
  assert.deepEqual(partitionBacklog([]), { kept: [], omitted: 0 });
  assert.deepEqual(partitionBacklog(undefined), { kept: [], omitted: 0 });
  assert.deepEqual(partitionBacklog([entry('a', 'hi', 1)]).kept.length, 1);
});

test('renderBacklog：带相对时间、省略行与 SKIP 出口，第一行就交代「刚才在忙」', () => {
  const now = 1_000_000_000;
  const list = [
    entry('kaguya', '帮我看看那个报错', now - 8 * 60_000),
    entry('iroha', '在吗', now - 3 * 60_000),
    entry('mutsumi', '那个图我找到了', now - 40_000),
  ];
  const text = renderBacklog(list, { now, maxEntries: 20, maxChars: 2000 });
  const lines = text.split('\n');
  assert.equal(lines[0], '（你刚才在忙别的事，下面这些是那期间陆续到的消息，你现在才抬头看到）');
  assert.ok(text.includes('kaguya（8 分钟前）: 帮我看看那个报错'), text);
  assert.ok(text.includes('iroha（3 分钟前）: 在吗'), text);
  assert.ok(text.includes('mutsumi（40 秒前）: 那个图我找到了'), text);
  // 「挑着接 + 可以不接」这两条出口必须都在，否则模型会逐条点名回一遍。
  assert.ok(text.includes('别把它们当成刚发生的事，也别一条一条点着名字回答'), text);
  assert.ok(text.includes('就只写 SKIP'), text);
  assert.ok(text.includes('[[@昵称]]'), text);
  // 没有省略时不该出现「更早还有」。
  assert.ok(!text.includes('更早还有'), text);
});

test('renderBacklog：条数被折掉时说清「更早还有 N 条」，有 qq_transcript 才提它', () => {
  const now = 1_000_000_000;
  const list = wave(30, now);
  const withTool = renderBacklog(list, { now, maxEntries: 20, maxChars: 1_000_000, canLookup: true });
  assert.ok(withTool.includes('（更早还有 10 条没贴出来；想查就用 qq_transcript 翻记录）'), withTool);
  const withoutTool = renderBacklog(list, { now, maxEntries: 20, maxChars: 1_000_000, canLookup: false });
  assert.ok(withoutTool.includes('（更早还有 10 条没贴出来）'), withoutTool);
  // 记忆关掉时 `qq_transcript` 根本不存在，提示它去用一个不存在的工具比不说更糟。
  assert.ok(!withoutTool.includes('qq_transcript'), withoutTool);
});

test('renderBacklog：只有一条也照样交代「这是刚才忙的时候到的」', () => {
  const now = 1_000_000_000;
  const text = renderBacklog([entry('kaguya', '在吗', now - 5 * 60_000)], { now });
  assert.ok(text.startsWith('（你刚才在忙别的事'), text);
  assert.ok(text.includes('kaguya（5 分钟前）: 在吗'), text);
});

test('renderBacklog：正文里的换行被折成一行，空入参返回空串', () => {
  const now = 1_000_000_000;
  const text = renderBacklog([entry('kaguya', '第一行\n第二行', now)], { now });
  assert.ok(text.includes('kaguya（刚刚）: 第一行 第二行'), text);
  assert.equal(renderBacklog([], { now }), '');
});

test('renderBacklog：带转发块的消息保留多行并缩进，普通消息仍折成一行', () => {
  const now = 1_000_000_000;
  const list = [
    { name: 'a', body: '[合并转发 2 条]\nkaguya: 你看这个\ntester: 笑死', forward: true, at: now - 60_000 },
    { name: 'b', body: '普通\n多行', at: now - 30_000 },
  ];
  const text = renderBacklog(list, { now, maxEntries: 20, maxChars: 2000 });
  assert.match(text, /a（1 分钟前）: \[合并转发 2 条\]\n  kaguya: 你看这个\n  tester: 笑死/);
  assert.match(text, /b（30 秒前）: 普通 多行/);
});
