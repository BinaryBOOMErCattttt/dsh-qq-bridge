/**
 * `modalities.js`（感知层）的纯函数测试。
 *
 * 这里钉的是**渲染契约**：一条 OneBot 消息段变成模型读到的那几个方括号。
 * 为什么值得单独测：
 *   - 这些字符串直接进提示词，改一个标点就是改模型看到的世界；`bridge.test.mjs`
 *     只端到端覆盖了图片/表情包那两种，语音/视频/文件/卡片/转发没有出口；
 *   - 感知层刻意不做 IO（下载在 `media.js`、卡片解析在 `links.js`），所以这里可以
 *     纯函数式地断言「有路径 / 没路径 / 取失败」三种状态，不碰网络也不碰磁盘；
 *   - 畸形输入（null 段、缺 `data`、非数组消息）必须只降级、不抛错 —— QQ 消息
 *     是不可信输入，任何一段坏数据都不该让整条消息文本化失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mediaLabel, mediaPlaceholder, observationOf, observationsOf, renderMessage, renderObservation, renderSegment } from '../modalities.js';

/** 造一个消息段：测试里只关心 `type` 与 `data`。 */
const seg = (type, data = {}) => ({ type, data });

/** 「把这个段渲染成文本」——绝大多数用例只用这一句。 */
const render = (segment) => renderObservation(observationOf(segment));

// ---------------------------------------------------------------------------
// 标签与媒体占位符：从 onebot.js 搬过来的既有契约，输出必须逐字不变。
// ---------------------------------------------------------------------------

test('mediaLabel 剥掉方括号、折叠空白、最多 40 字', () => {
  assert.equal(mediaLabel('[动画表情]'), '动画表情');
  assert.equal(mediaLabel('  [ 猫 \n 猫 ]  '), '猫 猫');
  // 只有一边有方括号时只剥那一边（原文就是这么写的）。
  assert.equal(mediaLabel('[猫猫'), '猫猫');
  assert.equal(mediaLabel('猫猫]'), '猫猫');
  // 空白 / null / undefined 都算「没有标签」。
  assert.equal(mediaLabel(' \n '), '');
  assert.equal(mediaLabel(undefined), '');
  assert.equal(mediaLabel(null), '');
  // 数字之类的非字符串也要能安全转成标签。
  assert.equal(mediaLabel(123), '123');
  // 截断按 40 字，防止一段摘要撑爆一行上下文。
  assert.equal(mediaLabel(`[${'x'.repeat(50)}]`).length, 40);
});

test('mediaPlaceholder 的三种既有文案逐字不变', () => {
  // 落盘成功：路径就是模型 read_image 的目标。
  assert.equal(mediaPlaceholder({ kind: 'image', label: '动画表情' }, '.qq-media/ab.gif'), '[图片(动画表情): .qq-media/ab.gif]');
  assert.equal(mediaPlaceholder({ kind: 'mface', label: '猫猫' }), '[表情包(猫猫)]');
  assert.equal(mediaPlaceholder({ kind: 'image', label: '' }), '[图片]');
  // 取文件失败：明确说没取到，而不是让模型对着一张不存在的图使劲。
  assert.equal(mediaPlaceholder({ kind: 'mface', label: '' }, '', 'HTTP 404'), '[表情包 没能取到文件: HTTP 404]');
  assert.equal(mediaPlaceholder({ kind: 'image', label: '动画表情' }, '', 'timeout'), '[图片(动画表情) 没能取到文件: timeout]');
  // 缺参数只降级，不抛错。
  assert.equal(mediaPlaceholder(undefined), '[图片]');
  assert.equal(mediaPlaceholder({ kind: 'image', label: 'x' }, undefined, undefined), '[图片(x)]');
});

// ---------------------------------------------------------------------------
// 文字 / @ / 回复：老行为一个字都不能变（`@bot你好` 靠 skipAtId 变成 `你好`）。
// ---------------------------------------------------------------------------

test('文字段：正文原样，kind/text/order 都对得上', () => {
  const observation = observationOf(seg('text', { text: '  看这个\n' }), { index: 3 });
  assert.equal(observation.kind, 'text');
  assert.equal(observation.order, 3);
  assert.equal(observation.text, '  看这个\n');
  assert.equal(observation.status, 'ok');
  // 正文不做 trim：空白是不是有意义由调用方决定。
  assert.equal(renderObservation(observation), '  看这个\n');
  // `data.text` 不是字符串时退回空串（老行为）。
  assert.equal(render(seg('text', { text: 123 })), '');
  assert.equal(render(seg('text')), '');
});

test('at 段：@名 / @全体成员，名字缺失时老行为照旧', () => {
  assert.equal(render(seg('at', { qq: 10001, name: '张三' })), '@张三');
  assert.equal(render(seg('at', { qq: 'all' })), '@全体成员');
  // 没有 name 就用 QQ 号；连 qq 都没有才用「某人」。
  assert.equal(render(seg('at', { qq: 10001 })), '@10001');
  assert.equal(render(seg('at')), '@某人');
  // 刻意保留老实现的 `??` 语义：name 是**空串**时不做兜底（仍然渲染 `@`），
  // 这样「这里 @ 了谁」至少还看得出来，不会凭空编一个名字。
  assert.equal(render(seg('at', { qq: 10001, name: '' })), '@');
  const observation = observationOf(seg('at', { qq: 10001, name: '张三' }));
  assert.equal(observation.kind, 'at');
  assert.equal(observation.label, '@张三');
  assert.equal(observation.meta.qq, 10001);
});

test('reply 段渲染成 [回复]', () => {
  assert.equal(render(seg('reply', { id: '123' })), '[回复]');
  assert.equal(observationOf(seg('reply', { id: '123' })).kind, 'reply');
});

// ---------------------------------------------------------------------------
// 图片 / 表情包：本地路径、取失败、没下载三种状态，文案仍是既有那几行。
// ---------------------------------------------------------------------------

test('图片段没落盘时是朴素占位符，状态是 skipped', () => {
  const observation = observationOf(seg('image', { summary: '[动画表情]', url: 'https://example.invalid/a', file: 'A.png' }));
  assert.equal(observation.kind, 'image');
  assert.equal(observation.label, '动画表情');
  assert.equal(observation.url, 'https://example.invalid/a');
  assert.equal(observation.status, 'skipped');
  assert.equal(renderObservation(observation), '[图片(动画表情)]');
  // 没有 summary 就没有括号。
  assert.equal(render(seg('image')), '[图片]');
});

test('mface 段归一成 sticker，但渲染文案仍是 [表情包…]', () => {
  const observation = observationOf(seg('mface', { emoji_id: '42', summary: '猫猫' }));
  assert.equal(observation.kind, 'sticker');
  assert.equal(observation.meta.sourceKind, 'mface');
  assert.equal(observation.status, 'skipped');
  assert.equal(renderObservation(observation), '[表情包(猫猫)]');
  assert.equal(render(seg('mface')), '[表情包]');
});

test('媒体段已经有 replacement 时状态是 fetched，渲染原样保留', () => {
  const observation = observationOf(seg('image', { summary: '动画表情' }), { index: 1, replacement: '[图片(动画表情): .qq-media/ab.gif]' });
  assert.equal(observation.order, 1);
  assert.equal(observation.status, 'fetched');
  // 由调用方渲染好的文本一字不改 —— 再按字段重拼就可能与既有输出不一致。
  assert.equal(renderObservation(observation), '[图片(动画表情): .qq-media/ab.gif]');
  // 空串也是合法的 replacement（「这一段不渲染」）。
  assert.equal(renderObservation(observationOf(seg('image'), { replacement: '' })), '');
});

test('取文件失败：reason 进占位符，不假装看见了图', () => {
  // 这种观测由调用方在下载失败时拼出来（status 为 failed）。
  const failed = { kind: 'image', order: 0, label: '动画表情', meta: {}, status: 'failed', reason: 'HTTP 404' };
  assert.equal(renderObservation(failed), '[图片(动画表情) 没能取到文件: HTTP 404]');
  assert.equal(renderObservation({ ...failed, kind: 'sticker', label: '' }), '[表情包 没能取到文件: HTTP 404]');
  // localPath 与 reason 同时存在时路径优先（与 mediaPlaceholder 的既有顺序一致）。
  assert.equal(renderObservation({ ...failed, localPath: '.qq-media/x.png' }), '[图片(动画表情): .qq-media/x.png]');
});

// ---------------------------------------------------------------------------
// 系统表情：有名字才写名字，**不猜** id→名称表。
// ---------------------------------------------------------------------------

test('face 段有名字时渲染 [表情: 名称]', () => {
  assert.equal(render(seg('face', { id: '14', name: '狗头' })), '[表情: 狗头]');
  // 不同实现把名字放在不同字段里：name → summary → face_text 依次取。
  assert.equal(render(seg('face', { id: '14', summary: '猫猫头' })), '[表情: 猫猫头]');
  assert.equal(render(seg('face', { id: '14', face_text: '捂脸' })), '[表情: 捂脸]');
  // name 为空串时继续往后找，而不是渲染一个空名字。
  assert.equal(render(seg('face', { id: '14', name: '', summary: '猫猫头' })), '[表情: 猫猫头]');
  const observation = observationOf(seg('face', { id: '14', name: '狗头' }));
  assert.equal(observation.kind, 'face');
  assert.equal(observation.label, '狗头');
});

test('face 段没有名字时退回 [表情]，不猜 id 的含义', () => {
  // 老行为；bridge.test.mjs 里 `{ type: 'face', data: { id: '13' } }` 的往返靠它。
  assert.equal(render(seg('face', { id: '13' })), '[表情]');
  assert.equal(render(seg('face')), '[表情]');
  assert.equal(render(seg('face', { id: '13', name: '  ' })), '[表情]');
});

// ---------------------------------------------------------------------------
// 语音：只做时长占位（本轮不转写），单位要猜一次（毫秒 or 秒）。
// ---------------------------------------------------------------------------

test('语音：秒为单位时渲染 [语音 3 秒]', () => {
  const observation = observationOf(seg('record', { file: 'a.amr', duration: 3 }));
  assert.equal(observation.kind, 'voice');
  assert.equal(observation.meta.durationMs, 3000);
  assert.equal(observation.status, 'skipped');
  assert.equal(renderObservation(observation), '[语音 3 秒]');
});

test('语音：NapCat 有时给毫秒，> 1000 按毫秒换算', () => {
  assert.equal(render(seg('record', { duration: 3000 })), '[语音 3 秒]');
  assert.equal(render(seg('record', { duration: 5000 })), '[语音 5 秒]');
  // 1000 本身仍按秒（实现之间的分界是「> 1000」）。
  assert.equal(render(seg('record', { duration: 1000 })), '[语音 1000 秒]');
});

test('语音：时长四舍五入到整秒，最少 1 秒', () => {
  assert.equal(render(seg('record', { duration: 1500 })), '[语音 2 秒]');
  assert.equal(render(seg('record', { duration: 2500 })), '[语音 3 秒]');
  assert.equal(render(seg('record', { duration: 0.6 })), '[语音 1 秒]');
  assert.equal(render(seg('record', { duration: 2400 })), '[语音 2 秒]');
  assert.equal(render(seg('record', { duration: 0.5 })), '[语音 1 秒]');
});

test('语音：没有可用时长时只写 [语音]', () => {
  assert.equal(render(seg('record')), '[语音]');
  assert.equal(render(seg('record', { duration: 0 })), '[语音]');
  assert.equal(render(seg('record', { duration: -3 })), '[语音]');
  assert.equal(render(seg('record', { duration: '' })), '[语音]');
  assert.equal(render(seg('record', { duration: 'abc' })), '[语音]');
  // 字符串数字也算数（OneBot 实现常把数字写成字符串）。
  assert.equal(render(seg('record', { duration: '3' })), '[语音 3 秒]');
});

// ---------------------------------------------------------------------------
// 视频：时长 + 封面路径（封面由调用方下载后写进 meta.coverPath，本模块不下载）。
// ---------------------------------------------------------------------------

test('视频：有时长渲染 [视频 12 秒]', () => {
  assert.equal(render(seg('video', { file: 'v.mp4', duration: 12 })), '[视频 12 秒]');
  assert.equal(render(seg('video', { duration: 12000 })), '[视频 12 秒]');
  const observation = observationOf(seg('video', { duration: 12, thumb: 'https://example.invalid/t.jpg' }));
  assert.equal(observation.kind, 'video');
  assert.equal(observation.status, 'skipped');
  // 封面地址只是原样记进 meta（给调用方决定下不下），本模块不下载、不发请求。
  assert.equal(observation.meta.thumb, 'https://example.invalid/t.jpg');
  assert.equal(observationOf(seg('video', { cover: 'https://example.invalid/c.jpg' })).meta.cover, 'https://example.invalid/c.jpg');
});

test('视频：没有时长时只写 [视频]', () => {
  assert.equal(render(seg('video', { file: 'v.mp4' })), '[视频]');
  assert.equal(render(seg('video', { duration: 0 })), '[视频]');
});

test('视频：有本地封面路径时缀上 · 封面:', () => {
  const observation = observationOf(seg('video', { duration: 12, thumb: 'https://example.invalid/t.jpg' }));
  observation.meta.coverPath = '.qq-media/ef56.jpg';
  assert.equal(renderObservation(observation), '[视频 12 秒 · 封面: .qq-media/ef56.jpg]');
  // 没有时长也要能带封面（视频段不一定给 duration）。
  const noDuration = observationOf(seg('video', { cover: 'https://example.invalid/c.jpg' }));
  noDuration.meta.coverPath = '.qq-media/ef56.jpg';
  assert.equal(renderObservation(noDuration), '[视频 · 封面: .qq-media/ef56.jpg]');
  // 空串不算封面。
  const empty = observationOf(seg('video', { duration: 12 }));
  empty.meta.coverPath = '';
  assert.equal(renderObservation(empty), '[视频 12 秒]');
});

// ---------------------------------------------------------------------------
// 文件：名字 + 大小（人读的 MB/KB），空名字退回 [文件]。
// ---------------------------------------------------------------------------

test('文件：名字 + 人类可读大小', () => {
  assert.equal(render(seg('file', { name: 'report.pdf', file_size: 1258291 })), '[文件 report.pdf（1.2 MB）]');
  assert.equal(render(seg('file', { name: 'a.png', file_size: 512 })), '[文件 a.png（512 B）]');
  assert.equal(render(seg('file', { name: 'a.png', file_size: 1536 })), '[文件 a.png（1.5 KB）]');
  assert.equal(render(seg('file', { name: 'a.png', file_size: 1024 })), '[文件 a.png（1 KB）]');
  assert.equal(render(seg('file', { name: 'a.png', file_size: 1048576 })), '[文件 a.png（1 MB）]');
  // `file_size` 常是字符串。
  assert.equal(render(seg('file', { name: 'a.zip', file_size: '2048' })), '[文件 a.zip（2 KB）]');
  const observation = observationOf(seg('file', { name: 'report.pdf', file_size: 1258291 }));
  assert.equal(observation.kind, 'file');
  assert.equal(observation.label, 'report.pdf');
  assert.equal(observation.meta.bytes, 1258291);
  assert.equal(observation.status, 'skipped');
});

test('文件：没有大小就不带括号，空名字退回 [文件]', () => {
  assert.equal(render(seg('file', { name: 'report.pdf' })), '[文件 report.pdf]');
  assert.equal(render(seg('file', { name: 'report.pdf', file_size: 0 })), '[文件 report.pdf]');
  assert.equal(render(seg('file', { name: 'report.pdf', file_size: 'abc' })), '[文件 report.pdf]');
  // 老行为：`[文件 ]`.trim() → `[文件]`；新实现显式处理空名字。
  assert.equal(render(seg('file', { name: '' })), '[文件]');
  assert.equal(render(seg('file', { name: '   ' })), '[文件]');
  assert.equal(render(seg('file')), '[文件]');
});

// ---------------------------------------------------------------------------
// 卡片（json / xml）：标题 + 域名 + URL，解析不出来就退回 [卡片消息]。
// ---------------------------------------------------------------------------

test('卡片观测：渲染格式是 [链接: 【标题】 — 域名 URL]', () => {
  const card = { kind: 'card', order: 0, label: '标题', meta: { title: '标题', desc: '摘要', site: 'example.com', url: 'https://example.com/a' }, status: 'ok' };
  assert.equal(renderObservation(card), '[链接: 【标题】 — example.com https://example.com/a]');
  // 只有 URL、没有域名时不留一个空档。
  assert.equal(renderObservation({ ...card, meta: { title: '标题', url: 'https://example.com/a' } }), '[链接: 【标题】 — https://example.com/a]');
  // 只有标题、没有链接时只写标题。
  assert.equal(renderObservation({ ...card, meta: { title: '标题' } }), '[链接: 【标题】]');
  // 标题是空的（或只有空白）→ 退回卡片占位符，不拼一个空方括号。
  assert.equal(renderObservation({ ...card, label: '', meta: { site: 'example.com', url: 'https://example.com/a' } }), '[卡片消息]');
  assert.equal(renderObservation({ ...card, label: '', meta: { title: '   ' } }), '[卡片消息]');
});

test('卡片段：解析不出来时退回 [卡片消息]，不抛错', () => {
  // 这两种是「有卡片但解析不出标题」：任何解析器都不该把异常漏到整条消息上。
  assert.equal(render(seg('json', { data: 'not json at all' })), '[卡片消息]');
  assert.equal(render(seg('xml', { data: '<xml></xml>' })), '[卡片消息]');
  assert.equal(render(seg('json')), '[卡片消息]');
  assert.equal(observationOf(seg('json', { data: '{}' })).kind, 'card');
});

test('卡片段：标准 json 卡片能解析出标题', () => {
  // 与 NapCat 上报的结构一致（doc §8.4：`data.data` 里是 JSON 字符串）。
  const payload = {
    app: 'com.tencent.structmsg',
    desc: '新闻',
    view: 'news',
    meta: {
      news: { title: '一条测试链接', desc: '摘要', jumpUrl: 'https://example.com/a', tag: '新闻' },
      detail_1: { title: '一条测试链接', desc: '摘要', qqdocurl: 'https://example.com/a', host: { nick: 'example.com' } },
    },
  };
  const rendered = render(seg('json', { data: JSON.stringify(payload) }));
  assert.match(rendered, /^\[链接: 【一条测试链接】/);
  const observation = observationOf(seg('json', { data: JSON.stringify(payload) }));
  assert.equal(observation.kind, 'card');
  assert.equal(observation.meta.title, '一条测试链接');
});

// ---------------------------------------------------------------------------
// 合并转发 / 戳一戳 / 不认识的类型。
// ---------------------------------------------------------------------------

test('合并转发：有内容数组时给条数', () => {
  const content = Array.from({ length: 8 }, (_, i) => ({ type: 'text', data: { text: String(i) } }));
  assert.equal(render(seg('forward', { content })), '[合并转发 8 条]');
  assert.equal(observationOf(seg('forward', { content })).meta.count, 8);
  assert.equal(render(seg('forward', { content: [] })), '[合并转发]');
  // content 不是数组（有些实现给 id 字符串）时只给占位符。
  assert.equal(render(seg('forward', { id: 'abc' })), '[合并转发]');
  assert.equal(render(seg('forward')), '[合并转发]');
});

test('node 段（转发里套转发）也渲染成转发占位符，不是 [node]', () => {
  const messages = Array.from({ length: 3 }, (_, i) => ({ sender: { nickname: `u${i}` }, message: [{ type: 'text', data: { text: String(i) } }] }));
  assert.equal(render(seg('node', { message: messages })), '[合并转发 3 条]');
  assert.equal(observationOf(seg('node', { message: messages })).kind, 'forward');
  // 没有 message 的 node 段只给占位符，别把协议名漏给模型。
  assert.equal(render(seg('node')), '[合并转发]');
});

test('戳一戳渲染成 [戳一戳]', () => {
  assert.equal(render(seg('poke', { id: '1' })), '[戳一戳]');
  assert.equal(observationOf(seg('poke')).kind, 'poke');
});

test('不认识的类型原样括起来，连类型都没有就是空串', () => {
  assert.equal(render(seg('share', { url: 'https://example.com' })), '[share]');
  assert.equal(render(seg('markdown')), '[markdown]');
  // 空字符串类型也照原样（老实现是 `[${type}]`）。
  assert.equal(render(seg('')), '[]');
  // 没有 type 的段渲染成空串（老行为）。
  assert.equal(render({}), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  const observation = observationOf(seg('share'));
  assert.equal(observation.kind, 'unknown');
  assert.equal(observation.label, 'share');
});

// ---------------------------------------------------------------------------
// 整条消息：拼接、skipAtId、media 映射、字符串消息。
// ---------------------------------------------------------------------------

test('observationsOf 按下标保序，并把 skipAtId 的 at 段丢掉', () => {
  const message = [seg('at', { qq: 10001, name: 'bot' }), seg('text', { text: '你好' }), seg('image', { summary: '猫' })];
  const all = observationsOf(message);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((item) => item.order), [0, 1, 2]);
  const skipped = observationsOf(message, { skipAtId: 10001 });
  // 被跳过的段整个不出现：观测数组里不该有「这次不该出现的东西」。
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map((item) => item.kind), ['text', 'image']);
  // 但 order 仍是原始下标，调用方按它对齐不会错。
  assert.deepEqual(skipped.map((item) => item.order), [1, 2]);
  // 数字 / 字符串 QQ 号都能跳过（OneBot 实现两种都会给）。
  assert.equal(renderMessage(message, { skipAtId: '10001' }), '你好[图片(猫)]');
  // skipAtId 不传时 @ 段照常渲染。
  assert.equal(renderMessage(message), '@bot你好[图片(猫)]');
  // 指向别人的 at 不受影响。
  assert.equal(renderMessage([seg('at', { qq: 20002, name: '张三' })], { skipAtId: 10001 }), '@张三');
});

test('renderMessage 用 media 映射替换媒体段，其余段不动', () => {
  const message = [seg('text', { text: '看这个' }), seg('image', { summary: '动画表情' }), seg('text', { text: '！' })];
  const media = new Map([[1, '[图片(动画表情): .qq-media/ab.gif]']]);
  assert.equal(renderMessage(message, { media }), '看这个[图片(动画表情): .qq-media/ab.gif]！');
  // 映射里没有的下标（或传的不是 Map）就当没下载。
  assert.equal(renderMessage(message, { media: new Map() }), '看这个[图片(动画表情)]！');
  assert.equal(renderMessage(message, { media: { 1: 'x' } }), '看这个[图片(动画表情)]！');
  // 调换位置也能命中：下标就是段的下标。
  assert.equal(renderMessage([seg('image', {}), seg('image', {})], { media: new Map([[1, '[图片: b]']]) }), '[图片][图片: b]');
});

test('renderMessage 对字符串消息原样返回，对畸形消息返回空串', () => {
  // CQ 码格式：看不出里面有什么，整条当一个文字观测。
  assert.equal(renderMessage('你好世界'), '你好世界');
  assert.equal(renderMessage(''), '');
  assert.deepEqual(observationsOf('你好').map((item) => item.kind), ['text']);
  // 不是消息段数组（字段缺失 / 上报格式不认识）时没有内容可渲染。
  assert.equal(renderMessage(null), '');
  assert.equal(renderMessage(undefined), '');
  assert.equal(renderMessage({ type: 'text', data: { text: 'x' } }), '');
  assert.equal(renderMessage(42), '');
  assert.deepEqual(observationsOf(null), []);
  assert.deepEqual(observationsOf({}), []);
});

test('renderSegment 等价于渲染单个段，replacement 优先', () => {
  assert.equal(renderSegment(seg('text', { text: 'hi' })), 'hi');
  assert.equal(renderSegment(seg('image', { summary: '猫' })), '[图片(猫)]');
  assert.equal(renderSegment(seg('face', { id: '1', name: '狗头' })), '[表情: 狗头]');
  // replacement 是空串时也算「给了替换」，直接返回空串。
  assert.equal(renderSegment(seg('image', { summary: '猫' }), '[图片(猫): .qq-media/a.png]'), '[图片(猫): .qq-media/a.png]');
  assert.equal(renderSegment(seg('text', { text: 'hi' }), ''), '');
  // 畸形输入不抛错。
  assert.equal(renderSegment(null), '');
  assert.equal(renderSegment(undefined, undefined), '');
});

test('缺 data / 段不是对象时逐段降级，不抛错', () => {
  // 每个段都缺 `data`：各自退回朴素占位符，整条消息仍然渲染得出来。
  const message = [seg('image'), seg('face'), seg('record'), seg('video'), seg('file'), seg('json'), seg('forward'), seg('poke'), seg('share')];
  assert.equal(renderMessage(message), '[图片][表情][语音][视频][文件][卡片消息][合并转发][戳一戳][share]');
  // 数组里混进 null / 字符串：null 段当空壳（空串），字符串段没有 type（空串）。
  assert.equal(renderMessage([seg('text', { text: 'a' }), null, 'x', seg('text', { text: 'b' })]), 'ab');
  // 非对象的 data（比如字符串）不能把字段访问炸掉。
  assert.equal(render(seg('text', 'not-an-object')), '');
  assert.equal(render(seg('image', 'not-an-object')), '[图片]');
  assert.equal(render(seg('at', 'not-an-object')), '@某人');
});

test('renderObservation 对空壳观测返回空串', () => {
  assert.equal(renderObservation(null), '');
  assert.equal(renderObservation(undefined), '');
  assert.equal(renderObservation({}), '');
  assert.equal(renderObservation({ kind: 'text' }), '');
  // 观测里没 meta 也不能炸（at 的 label 直接返回）。
  assert.equal(renderObservation({ kind: 'poke' }), '[戳一戳]');
  assert.equal(renderObservation({ kind: 'face', label: '' }), '[表情]');
});
