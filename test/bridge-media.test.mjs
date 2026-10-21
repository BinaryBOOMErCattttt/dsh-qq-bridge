/**
 * 集成测试分册：入站媒体与出站图片（下载 / 缓存 / qq_send_image）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-media.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectMedia, mediaLabel, mediaPlaceholder, messageToText } from '../onebot.js';
import { createMediaStore, sniffImageExtension } from '../media.js';
import { SELF_ID, TINY_PNG, startImageServer, promptText, turnContextText, until, privateMessageWithImage, privateMessageWithReply, groupMessage, mention, boot } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


// ---------------------------------------------------------------------------
// 「读表情包」相关行为：图片/表情包落盘、占位文本、抓不到时的降级。
// ---------------------------------------------------------------------------

// 用例二十：媒体段的收集与渲染（纯函数）。
test('media segments are collected and rendered with their local path', () => {
  const message = [
    { type: 'at', data: { qq: SELF_ID } },
    { type: 'image', data: { summary: '[动画表情]', url: 'https://example.invalid/a', file: 'A.png', file_size: '2048' } },
    { type: 'text', data: { text: '看这个' } },
    { type: 'mface', data: { emoji_id: '42', summary: '猫猫' } },
    { type: 'face', data: { id: '14' } },
  ];
  assert.deepEqual(collectMedia(message), [
    { index: 1, kind: 'image', label: '动画表情', url: 'https://example.invalid/a', file: 'A.png', declaredBytes: 2048 },
    { index: 3, kind: 'mface', label: '猫猫', url: '', file: '', declaredBytes: undefined },
  ]);
  // 纯文本消息（以及 CQ 码字符串）里没有媒体段。
  assert.deepEqual(collectMedia([{ type: 'text', data: { text: 'hi' } }]), []);
  assert.deepEqual(collectMedia('[CQ:image,file=x.png]'), []);

  // 没有映射时就是朴素占位符 —— 媒体还没落盘、下载失败、或 mediaDownload / ambientMedia 关掉时。
  assert.equal(messageToText(message, SELF_ID), '[图片(动画表情)]看这个[表情包(猫猫)][表情]');
  // 有映射时整段被替换成本地路径，模型才知道该 read_image 哪个文件。
  const media = new Map([[1, mediaPlaceholder({ kind: 'image', label: '动画表情' }, '.qq-media/ab.gif')]]);
  assert.equal(messageToText(message, SELF_ID, media), '[图片(动画表情): .qq-media/ab.gif]看这个[表情包(猫猫)][表情]');
  // 抓不到文件时明说，而不是让模型对着一张不存在的图使劲。
  assert.equal(mediaPlaceholder({ kind: 'image', label: '动画表情' }, '', 'HTTP 404'), '[图片(动画表情) 没能取到文件: HTTP 404]');
  assert.equal(mediaPlaceholder({ kind: 'mface', label: '' }, '', 'x'), '[表情包 没能取到文件: x]');

  // summary 的方括号被剥掉，纯空白不算标签。
  assert.equal(mediaLabel('[动画表情]'), '动画表情');
  assert.equal(mediaLabel(' \n '), '');
  assert.equal(mediaLabel(undefined), '');
});


// 用例二十一：魔数识别只认 read_image 支持的那四种格式。
test('sniffImageExtension recognises exactly the four readable formats', () => {
  assert.equal(sniffImageExtension(TINY_PNG), 'png');
  assert.equal(sniffImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'jpg');
  assert.equal(sniffImageExtension(Buffer.from('GIF89a....', 'latin1')), 'gif');
  assert.equal(sniffImageExtension(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  // 腾讯的下载链接不带扩展名，认格式只能靠字节；认不出来就拒绝落盘。
  assert.equal(sniffImageExtension(Buffer.from('<html>404</html>')), undefined);
  assert.equal(sniffImageExtension(Buffer.alloc(0)), undefined);
});


// 用例二十二：私聊里发来的图片会落盘，Agent 拿到的是可以 read_image 的路径。
test('an inbound image is downloaded so the agent can actually read it', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '你看这个' }));
    // 等「消息真的投递了」而不是「Agent 建出来了」：媒体是先落盘再投递的，
    // 中间隔着一个真实的 HTTP 往返，只看 created 会读到还没进收件箱的 Agent。
    await until(() => host.list.created[0]?.inbox.length === 1, 'the image message to be delivered');
    const body = host.list.created[0].inbox[0].content[0].text;
    // 占位符里带着相对 cwd 的路径，正文其余部分原样保留。
    const match = /\[图片\(动画表情\): (media\/([0-9a-f]{32})\.png)\]你看这个/.exec(body);
    assert.ok(match, body);
    // 落盘的必须是原字节（而不是被截断/转码过的东西）。
    assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
    assert.equal(images.hits.length, 1);

    // 提示词要告诉模型「这类路径是可以读的」，否则它只会对着路径发呆。
    const prompt = promptText(host, 'qq-bridge:channel');
    assert.ok(prompt.includes('read_image'), prompt);
    assert.ok(prompt.includes('`[图片: 路径]`'), prompt);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例二十三：同一张图反复发只存一份；超过上限就按最近使用时间淘汰最旧的。
test('the media cache dedupes by content and evicts the oldest files', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '一' }));
    onebot.push(privateMessageWithImage(images.url(), { text: '二' }));
    await until(() => host.list.created[0]?.inbox.length === 2, 'both messages to be delivered');
    // 下载了两次（每次都是新消息），但内容哈希相同 -> 缓存里只有一个文件。
    assert.equal(images.hits.length, 2);
    assert.equal((await readdir(join(mediaRoot, 'media'))).length, 1);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 淘汰：手工造三个文件并拉开 mtime，只留最近的两个。
  const store = createMediaStore({ cwd: mediaRoot, dir: 'media', maxFiles: 2 });
  await mkdir(join(mediaRoot, 'media'), { recursive: true });
  const names = ['old.png', 'middle.png', 'new.png'];
  for (const [index, name] of names.entries()) {
    const target = join(mediaRoot, 'media', name);
    await writeFile(target, TINY_PNG);
    const when = new Date(Date.now() - (names.length - index) * 60_000);
    await utimes(target, when, when);
  }
  await store.prune();
  assert.deepEqual((await readdir(join(mediaRoot, 'media'))).sort(), ['middle.png', 'new.png']);
  await rm(mediaRoot, { recursive: true, force: true });
});


// 用例二十四：群聊环境上下文里的图默认也落盘（「刚才那张表情包」@ 它时它真的看得见）；
// ambientMedia: false 退回成「不为闲聊花带宽和磁盘」的老行为。
test('images in group chatter are downloaded unless ambientMedia is off', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    // 没被 @ 的群消息：只记进环境缓冲，但图会异步落盘。
    onebot.push(groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }], { messageId: 21 }));
    await until(() => images.hits.length === 1, 'the ambient image to be downloaded');
    assert.equal(host.list.created.length, 0);

    // 随后被 @：上下文里那条已经改写成带路径的版本，模型可以 read_image。
    onebot.push(mention('这啥', { messageId: 22 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const prompt = await until(
      () => (/kaguya: \[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]/.exec(turnContextText(agent)) ?? undefined),
      'the ambient line to carry the local path',
    );
    // 落盘的确实是原字节。
    assert.deepEqual(await readFile(join(mediaRoot, prompt[1])), TINY_PNG);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 关掉开关：一条请求都不发，上下文里只有朴素占位符。
  const quietImages = await startImageServer(TINY_PNG);
  const quietRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const quiet = await boot({ cwd: quietRoot, mediaDir: 'media', ambientMedia: false });
  try {
    quiet.onebot.push(groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: quietImages.url() } }], { messageId: 21 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(quietImages.hits.length, 0, 'ambient images must not be downloaded when ambientMedia is off');
    quiet.onebot.push(mention('这啥', { messageId: 22 }));
    await until(() => quiet.host.list.created[0], 'the group Agent');
    const prompt = turnContextText(quiet.host.list.created[0]);
    assert.ok(prompt.includes('[图片(动画表情)]'), prompt);
    // 只断言「没有真的落盘路径」：提示词里作为例子提到 `.qq-media/…` 是另一回事。
    assert.ok(!/media\/[0-9a-f]{32}\./.test(prompt), prompt);
    assert.equal(quietImages.hits.length, 0);
  } finally {
    await quiet.onebot.close();
    await quietImages.close();
    await rm(quietRoot, { recursive: true, force: true });
  }
});


// 用例二十四之二：被引用的那条消息会被 get_msg 取回来 —— 引用一张表情包再 @ 它，图能落盘；
// 引用纯文本时原文直接进正文；实现不支持 get_msg 时安静降级成 `[回复]`。
test('a quoted message is fetched so quoted images become readable', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const asked = [];
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' }, {}, {
    getMsg: async (params) => {
      asked.push(params.message_id);
      return {
        message_id: params.message_id,
        sender: { card: 'kaguya', nickname: 'tomori', user_id: 100000003 },
        message: [{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }],
      };
    },
  });
  try {
    // 「引用某条消息 + @bot 这啥」：图不在本条消息里，只在被引用的那条里。
    onebot.push(groupMessage([
      { type: 'reply', data: { id: '7001' } },
      { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
      { type: 'text', data: { text: '这啥表情' } },
    ], { messageId: 7002 }));
    await until(() => host.list.created[0]?.inbox.length === 1, 'the quoting message to be delivered');
    const body = host.list.created[0].inbox[0].content[0].text;
    // message_id 按整数传给 get_msg（NapCat 的形状），引用前缀里带的是可 read_image 的路径。
    assert.deepEqual(asked, [7001]);
    const match = /^（引用 kaguya: \[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]）\n这啥表情$/.exec(body);
    assert.ok(match, body);
    assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
    // 提示词要交代「（引用 某某: …）」是什么，否则模型会把它读成对方原话的一部分。
    assert.ok(promptText(host, 'qq-bridge:channel').includes('（引用 某某: …）'));
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 引用纯文本：原文进正文，不需要任何媒体。
  const textRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const quotedText = await boot({ cwd: textRoot, mediaDir: 'media' }, {}, {
    getMsg: async () => ({ sender: { card: 'iroha' }, message: [{ type: 'text', data: { text: '你看这个 https://example.com/a' } }] }),
  });
  try {
    quotedText.onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => quotedText.host.list.created[0]?.inbox.length === 1, 'the quoting private message to be delivered');
    assert.equal(
      quotedText.host.list.created[0].inbox[0].content[0].text,
      '（引用 iroha: 你看这个 https://example.com/a）\n在吗',
    );
  } finally {
    await quotedText.onebot.close();
    await rm(textRoot, { recursive: true, force: true });
  }

  // 实现不支持 get_msg：只记一条 warn，正文照常投递，引用退化成 `[回复]`。
  const bareRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const bare = await boot({ cwd: bareRoot, mediaDir: 'media' });
  try {
    bare.onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => bare.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
    assert.equal(bare.host.list.created[0].inbox[0].content[0].text, '[回复]在吗');
    assert.ok(
      bare.host.list.warnings.some((line) => line.includes('could not fetch message 6650')),
      bare.host.list.warnings.join('\n'),
    );
  } finally {
    await bare.onebot.close();
    await rm(bareRoot, { recursive: true, force: true });
  }
});


// 用例二十四之三：quoteMedia: false 回到老行为 —— 引用段就是一句 `[回复]`，一次 get_msg 都不发。
test('quoteMedia: false leaves the reply segment as a bare placeholder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const asked = [];
  const { onebot, host } = await boot({ cwd: root, mediaDir: 'media', quoteMedia: false }, {}, {
    getMsg: async (params) => {
      asked.push(params.message_id);
      return { message: [{ type: 'text', data: { text: '不该被取回来' } }] };
    },
  });
  try {
    onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
    assert.equal(host.list.created[0].inbox[0].content[0].text, '[回复]在吗');
    assert.deepEqual(asked, []);
  } finally {
    await onebot.close();
    await rm(root, { recursive: true, force: true });
  }
});


// 用例二十五：抓不到图（rkey 过期 / CDN 报错）时降级成占位符，消息本身照常送达；
// 还能靠 OneBot 的 get_image 兜底拿到 base64。
test('a failing image download degrades, and get_image can still save it', async () => {
  const dead = await startImageServer(TINY_PNG, { status: 404 });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  try {
    // 一：URL 抓不动、OneBot 也不支持 get_image -> 只留一句「没能取到文件」。
    const plain = await boot({ cwd: mediaRoot, mediaDir: 'media' });
    try {
      plain.onebot.push(privateMessageWithImage(dead.url(), { text: '在吗' }));
      await until(() => plain.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      const body = plain.host.list.created[0].inbox[0].content[0].text;
      assert.match(body, /^\[图片\(动画表情\) 没能取到文件: [^\]]+\]在吗$/, body);
      assert.ok(plain.host.list.warnings.some((line) => line.includes('could not fetch image')));
    } finally {
      await plain.onebot.close();
    }

    // 二：URL 依然不行，但 get_image 回了 base64 -> 照样落盘、正文里给出路径。
    const rescued = await boot({ cwd: mediaRoot, mediaDir: 'media' }, {}, { getImage: () => ({ base64: TINY_PNG.toString('base64') }) });
    try {
      rescued.onebot.push(privateMessageWithImage(dead.url(), { text: '在吗' }));
      await until(() => rescued.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      const body = rescued.host.list.created[0].inbox[0].content[0].text;
      const match = /\[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]在吗/.exec(body);
      assert.ok(match, body);
      assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
      assert.ok(rescued.onebot.calls.some((call) => call.action === 'get_image'));
    } finally {
      await rescued.onebot.close();
    }
  } finally {
    await dead.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例二十六：mediaDownload: false 完全不碰网络；超过 mediaMaxBytes 的图不下载。
test('media download can be turned off and oversized images are skipped', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  try {
    const off = await boot({ cwd: mediaRoot, mediaDir: 'media', mediaDownload: false });
    try {
      off.onebot.push(privateMessageWithImage(images.url(), { text: '看图' }));
      await until(() => off.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      assert.equal(off.host.list.created[0].inbox[0].content[0].text, '[图片(动画表情)]看图');
      assert.equal(images.hits.length, 0);
    } finally {
      await off.onebot.close();
    }

    // 图上标着 file_size 且超过上限：连请求都不发。
    const capped = await boot({ cwd: mediaRoot, mediaDir: 'media', mediaMaxBytes: 1024 });
    try {
      capped.onebot.push(privateMessageWithImage(images.url(), { text: '看图', fileSize: 999999 }));
      await until(() => capped.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      assert.match(capped.host.list.created[0].inbox[0].content[0].text, /^\[图片\(动画表情\) 没能取到文件: too large/);
      assert.equal(images.hits.length, 0);
      // 提示词里仍然会提图片这件事（下载能力是开着的，只是这张图太大）。
      assert.ok(promptText(capped.host, 'qq-bridge:channel').includes('read_image'));
    } finally {
      await capped.onebot.close();
    }
  } finally {
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例二十七：缓存目录被配置到 cwd 外面时必须整体停用 —— 写出去的图 Agent 读不到，
// 而且那是把文件丢到工作区外面去。
test('a media directory outside cwd disables the cache', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const warnings = [];
  const store = createMediaStore({ cwd: mediaRoot, dir: '../escape', report: (level, message) => warnings.push(message) });
  assert.equal(store.enabled, false);
  assert.ok(warnings.some((line) => line.includes('outside cwd')), warnings.join('|'));
  const outcome = await store.resolve({ kind: 'image', url: 'http://127.0.0.1:1/x.png' });
  assert.equal(outcome.path, undefined);
  await rm(mediaRoot, { recursive: true, force: true });
});
