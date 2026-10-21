/**
 * 集成测试分册：复读（群里同一条消息的自动跟读）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-repeat.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTHER_PNG, PIC_JPEG, PIC_PNG } from './image-fixtures.mjs';
import { TINY_PNG, startImageServer, until, privateMessage, groupMessage, mention, sentTexts, boot, groupText, settle, groupSticker, sentImageBytes } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


// 用例：有人接了一句之后，机器人跟着复读 —— 不建会话、不经过模型、不带引用。
test('two identical group messages make the bot repeat along', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 20 }));
    await settle();
    // 只有一条时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupText('6', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 21 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeated message'), '6');
    // 复读是插件直接发的纯文本：不带引用/@，也不该为此建一个 Agent 会话。
    const call = onebot.calls.find((item) => item.action === 'send_group_msg');
    assert.equal(call.params.group_id, '100000001');
    assert.equal(call.params.message, '6');
    assert.equal(host.list.created.length, 0);
    const listed = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.deepEqual(listed.sessions, []);
  } finally {
    await onebot.close();
  }
});


// 用例：中间有人说了别的话，前后两条就不算「连着」。
test('a different message in between breaks the repeat chain', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 30 }));
    onebot.push(groupText('草', { userId: 3333333333, card: 'iroha', messageId: 31 }));
    onebot.push(groupText('6', { messageId: 32 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});


// 用例：默认要求至少两个不同的人说过 —— 一个人自己连发两遍是手滑，不是复读。
test('one person sending the same thing twice is not a repeat', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('草', { messageId: 40 }));
    onebot.push(groupText('草', { messageId: 41 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    // 换个人接一句，链已经攒够，立刻跟上。
    onebot.push(groupText('草', { userId: 3333333333, card: 'iroha', messageId: 42 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '草');
  } finally {
    await onebot.close();
  }
});


// 用例：repeatDistinct: false 时，同一个人连发两条也算（想让它更爱复读的一种玩法）。
test('repeatDistinct: false lets one person echo themselves', async () => {
  const { onebot } = await boot({ repeatDistinct: false });
  try {
    onebot.push(groupText('6', { messageId: 50 }));
    onebot.push(groupText('6', { messageId: 51 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6');
  } finally {
    await onebot.close();
  }
});


// 用例：repeatCount 决定「攒几个人」；repeat: false / repeatChance: 0 则完全不跟。
test('repeatCount decides how many echoes are needed, and the switch can turn it off', async () => {
  const three = await boot({ repeatCount: 3 });
  try {
    three.onebot.push(groupText('6', { messageId: 60 }));
    three.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 61 }));
    await settle();
    // 两个人才到一半，还不跟。
    assert.deepEqual(sentTexts(three.onebot), []);
    three.onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 62 }));
    assert.equal(await until(() => sentTexts(three.onebot)[0], 'the third echo to trigger the repeat'), '6');
  } finally {
    await three.onebot.close();
  }

  const off = await boot({ repeat: false });
  try {
    off.onebot.push(groupText('6', { messageId: 63 }));
    off.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 64 }));
    await settle();
    assert.deepEqual(sentTexts(off.onebot), []);
  } finally {
    await off.onebot.close();
  }

  // repeatChance: 0 时一次都不掷中（概率的边界，用确定的方式验证）。
  const shy = await boot({ repeatChance: 0 });
  try {
    shy.onebot.push(groupText('6', { messageId: 65 }));
    shy.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 66 }));
    await settle();
    assert.deepEqual(sentTexts(shy.onebot), []);
  } finally {
    await shy.onebot.close();
  }
});


// 用例：太长的话（一整段）不复读；隔得太久的相同消息也不算「连着」。
test('long messages and far-apart messages are not repeated', async () => {
  const long = await boot({ repeatMaxChars: 10 });
  try {
    const paragraph = '这段话太长了不适合复读';
    long.onebot.push(groupText(paragraph, { messageId: 70 }));
    long.onebot.push(groupText(paragraph, { userId: 3333333333, card: 'iroha', messageId: 71 }));
    await settle();
    assert.deepEqual(sentTexts(long.onebot), []);
  } finally {
    await long.onebot.close();
  }

  const stale = await boot({ repeatWindowMs: 40 });
  try {
    stale.onebot.push(groupText('6', { messageId: 72 }));
    await settle(120);
    stale.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 73 }));
    await settle();
    assert.deepEqual(sentTexts(stale.onebot), []);
  } finally {
    await stale.onebot.close();
  }

  // repeatWindowMs: 0 = 不限间隔：隔一会儿再说同一句照样算。
  const unlimited = await boot({ repeatWindowMs: 0 });
  try {
    unlimited.onebot.push(groupText('6', { messageId: 74 }));
    await settle(120);
    unlimited.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 75 }));
    assert.equal(await until(() => sentTexts(unlimited.onebot)[0], 'the repeat with no window'), '6');
  } finally {
    await unlimited.onebot.close();
  }
});


// 用例：图、表情、@ 别人的消息都不复读 —— 复读出去只会变成占位符或再 @ 人家一次。
// 用例：取不到字节的图（URL 过期、实现不给可下载地址、下载关着）不复读 —— 判「是不是同一张」
// 只能靠内容哈希，拿不到字节就别猜；顺带确认这种图也不会把消息链路弄坏。
test('images that cannot be downloaded are never repeated', async () => {
  const { onebot } = await boot();
  try {
    const dead = (messageId, userId, card) => groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'x.gif', url: '' } }], { messageId, userId, card });
    onebot.push(dead(210, 100000003, 'kaguya'));
    onebot.push(dead(211, 3333333333, 'iroha'));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});


// 用例：一串相同消息里只跟一次 —— 跟完之后链留着（标成 `repeated`），后面再来同样的
// 消息只记账、不再跟，直到有人说了别的话把链打断，下一串才重新攒人数。
test('the bot repeats once per run, and only starts over after the chain breaks', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 90 }));
    onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 91 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6');

    // 第 3、4、5 条相同的消息都不该再跟一次：这一串已经跟过了。
    onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 92 }));
    onebot.push(groupText('6', { userId: 5555555555, name: 'anon', card: 'anon', messageId: 93 }));
    onebot.push(groupText('6', { userId: 6666666666, name: 'soyo', card: 'soyo', messageId: 94 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), ['6'], '一串只跟一次，不该连发第二条');

    // 有人说了别的：链被打断，下一串要重新攒（两条相同的才又跟一次）。
    onebot.push(groupText('7', { userId: 7777777777, name: 'taki', card: 'taki', messageId: 95 }));
    await settle();
    onebot.push(groupText('6', { userId: 8888888888, name: 'tomori', card: 'tomori', messageId: 96 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), ['6'], '单独一条不算「连着」');

    onebot.push(groupText('6', { userId: 9999999999, name: 'rikki', card: 'rikki', messageId: 97 }));
    await until(() => sentTexts(onebot).length === 2, 'the second repeat');
    assert.deepEqual(sentTexts(onebot), ['6', '6']);
  } finally {
    await onebot.close();
  }
});


// 用例：@ 机器人的那条走 Agent 回答，不会被顺带复读一遍（它同时也打断复读链）。
test('messages addressed to the bot are answered instead of echoed', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('你好', { messageId: 100 }));
    onebot.push(mention('你好', { userId: 3333333333, card: 'iroha', messageId: 101 }));
    await until(() => host.list.created[0], 'the group Agent');
    await settle();
    assert.deepEqual(sentTexts(onebot), []);

    // 两条 @ 打断了链：接下来要说两句一样的，才会被跟。
    onebot.push(groupText('你好', { messageId: 102 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    onebot.push(groupText('你好', { userId: 3333333333, card: 'iroha', messageId: 103 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '你好');
  } finally {
    await onebot.close();
  }
});


// 用例：groupTrigger: all 时每条都算被 @，复读没有插话的余地（它本来就在逐条回话）。
test('groupTrigger: all leaves no room for an echo', async () => {
  const { onebot, host } = await boot({ groupTrigger: 'all' });
  try {
    onebot.push(groupText('6', { messageId: 104 }));
    onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 105 }));
    await until(() => host.list.created[0], 'the group Agent');
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});


// 用例：复读只在允许的群里发生；私聊里连发两条一样的不跟。
test('the echo stays inside allowed groups and out of private chat', async () => {
  const { onebot } = await boot({ allowGroups: ['100000001'] });
  try {
    const other = (messageId, userId) => ({
      post_type: 'message',
      message_type: 'group',
      group_id: 555555555,
      user_id: userId,
      message_id: messageId,
      sender: { nickname: 'soyo' },
      message: [{ type: 'text', data: { text: '6' } }],
    });
    onebot.push(other(110, 10001));
    onebot.push(other(111, 10002));
    onebot.push(privateMessage('6'));
    onebot.push(privateMessage('6'));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), []);
  } finally {
    await onebot.close();
  }
});


// 用例：只有空白不同（换行、多个空格）的相同正文照样算复读，发出去的是后一条的原文。
test('whitespace-only differences still count, and the later wording is what goes out', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('  6 6  ', { messageId: 120 }));
    onebot.push(groupText('6  6\n', { userId: 3333333333, card: 'iroha', messageId: 121 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6  6');
  } finally {
    await onebot.close();
  }
});


// 用例：复读是**原样文字**，正文里的 `[[图片: …]]` 标记不会被当成发文件的指令。
test('a repeated line is never parsed as a sticker marker', async () => {
  const { onebot } = await boot();
  try {
    const line = '[[图片: .qq-stickers/笑死.gif]]';
    onebot.push(groupText(line, { messageId: 130 }));
    onebot.push(groupText(line, { userId: 3333333333, card: 'iroha', messageId: 131 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), line);
    // 群里人打的是字，不是指令：发出去的必须是同样一行字，而不是一张图。
    assert.equal(typeof onebot.calls.find((item) => item.action === 'send_group_msg').params.message, 'string');
  } finally {
    await onebot.close();
  }
});


// 用例：同一张表情包连着出现两次 —— 跟着把那张发回去；不建会话，也不多花带宽。
test('two identical stickers in a row get echoed', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 140 }));
    await settle();
    // 只有一张时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupSticker(images.url(), { messageId: 141, userId: 3333333333, card: 'iroha' }));
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message)),
      'the repeated sticker',
    );
    assert.equal(sent.params.group_id, '100000001');
    assert.equal(sent.params.message.length, 1);
    assert.deepEqual(sentImageBytes(sent), TINY_PNG);
    // 复读要原样接上：原消息是表情，发回去也得带 QQ 的大表情标记（否则群里看到的是
    // 照片样式的图片，一眼就不是人发的表情）。
    assert.equal(sent.params.message[0].data.sub_type, 1);
    // 复读是插件直接发的：不建会话、不经过模型。
    assert.equal(host.list.created.length, 0);
    // 判「是不是同一张」要内容哈希，而这份字节就是环境上下文落盘时留下的：
    // 两条消息 = 两次下载（`mediaFor` 按消息对象共用同一次），没有为复读多拉一遍。
    assert.equal(images.hits.length, 2);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：复读按**原消息的样子**发 —— 原消息是表情就带大表情标记，是普通图片就不带。
// 群里两种「图」混着出现很正常：截图/照片不能标成表情（会被 QQ 按表情裁小），
// 而带 `emoji_id` 的商城表情（NapCat 把它折成 image 段，没有 sub_type）要按表情发回去。
test('a repeated picture keeps its kind: sticker stays a sticker, photo stays a photo', async () => {
  const images = await startImageServer(TINY_PNG);
  // 第二段用**另一张图**：同一张图在第一段已经跟过一次了，而「一串只跟一次」之后
  // 再来同一张不会再跟（这里验的是「表情按表情发」，不是复读的触发条件）。
  const market = await startImageServer(OTHER_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  const groupSends = () => onebot.calls.filter((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message));
  try {
    // 普通图片：NapCat 上报 `sub_type: 0`。复读出去仍是普通图片。
    onebot.push(groupSticker(images.url(), { messageId: 142, subType: 0 }));
    onebot.push(groupSticker(images.url(), { messageId: 143, userId: 3333333333, card: 'iroha', subType: 0 }));
    await until(() => groupSends().length >= 1, 'the repeated picture');
    assert.equal(groupSends()[0].params.message[0].data.sub_type, undefined);

    // 商城表情：NapCat 折成 `image` + `emoji_id`（没有 sub_type）。复读按表情发。
    const marketFace = (messageId, userId, card) => groupMessage(
      [{ type: 'image', data: { summary: '猫猫', file: 'A.gif', url: market.url(), emoji_id: '42' } }],
      { messageId, userId, card },
    );
    onebot.push(marketFace(144, 100000003, 'kaguya'));
    onebot.push(marketFace(145, 3333333333, 'iroha'));
    await until(() => groupSends().length >= 2, 'the repeated market face');
    assert.equal(groupSends()[1].params.message[0].data.sub_type, 1);
  } finally {
    await onebot.close();
    await images.close();
    await market.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：同一张图先以表情出现、后以普通图片出现（另存 / 转发会这样），复读仍按表情发 ——
// `sticker` 在链上累加（`repeatStep` 里的 OR），不是只看触发复读的最后一条。
// 真实事故：19:53 一条表情、19:54 同一张图被当成图片又发一遍，复读跟成了照片样式的图。
test('a sticker chain stays a sticker even when the last one is a picture', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  const groupSends = () => onebot.calls.filter((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message));
  try {
    onebot.push(groupSticker(images.url(), { messageId: 146, subType: 1 }));
    onebot.push(groupSticker(images.url(), { messageId: 147, userId: 3333333333, card: 'iroha', subType: 0, summary: '' }));
    await until(() => groupSends().length >= 1, 'the repeated sticker');
    assert.equal(groupSends()[0].params.message[0].data.sub_type, 1);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：不同的两张表情包不跟；表情包同样会打断文字链。
test('two different stickers do not repeat, and a sticker breaks a text chain', async () => {
  const first = await startImageServer(TINY_PNG);
  // 用另一张**真的不一样**的图（见 test/image-fixtures.mjs）：早先这里是在 TINY_PNG 后面
  // 追加几个字节假装「另一张」，但那两个文件在画面上其实是同一张 1×1 的图 —— 有了画面
  // 指纹之后，那种「伪不同」本来就该算同一张，不能再拿来当反例。
  const second = await startImageServer(OTHER_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(first.url(), { messageId: 150 }));
    onebot.push(groupSticker(second.url(), { messageId: 151, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);

    // 「6」→ 一张图 →「6」：中间那张图让前后两个 6 不再连着。
    onebot.push(groupText('6', { messageId: 152 }));
    onebot.push(groupSticker(first.url(), { messageId: 153, userId: 4444444444, card: 'mutsumi' }));
    onebot.push(groupText('6', { messageId: 154, userId: 5555555555, card: 'anon' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await first.close();
    await second.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：同一张画面被 QQ 按发送者重新编码（字节不同）时照样跟 —— 这是 2026-10-13 那天
// 群里连着发同一张「寿来」却没触发复读的原因，也是这个功能最常见的真实形态。
test('the same picture re-encoded by QQ still counts as the same sticker', async () => {
  const asPng = await startImageServer(PIC_PNG, { contentType: 'image/png' });
  const asJpeg = await startImageServer(PIC_JPEG, { contentType: 'image/jpeg' });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(asPng.url(), { messageId: 200, file: 'A.png' }));
    await settle();
    // 只有一张时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupSticker(asJpeg.url(), { messageId: 201, userId: 3333333333, card: 'iroha', file: 'A.jpg' }));
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message)),
      'the repeated sticker',
    );
    // 跟出去的是**后一条**那张图（复读机接的是刚说的那句），原字节就是它的 JPEG 字节。
    assert.deepEqual(sentImageBytes(sent), PIC_JPEG);
    // 依然不建会话、不经过模型。
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
    await asPng.close();
    await asJpeg.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：repeatImageTolerance: 0 时回到「只认字节完全相同」的旧行为 —— 画面一样但字节
// 不同的两张不跟（用户想自己决定要不要这层画面比对时的出口，也是这条链路的开关）。
test('repeatImageTolerance: 0 turns the picture comparison off', async () => {
  const asPng = await startImageServer(PIC_PNG, { contentType: 'image/png' });
  const asJpeg = await startImageServer(PIC_JPEG, { contentType: 'image/jpeg' });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', repeatImageTolerance: 0 });
  try {
    onebot.push(groupSticker(asPng.url(), { messageId: 210, file: 'A.png' }));
    onebot.push(groupSticker(asJpeg.url(), { messageId: 211, userId: 3333333333, card: 'iroha', file: 'A.jpg' }));
    await settle(300);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await asPng.close();
    await asJpeg.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：系统表情（face 段）不用下载，连着两个一样的也照跟。
test('two identical system faces get echoed', async () => {
  const { onebot } = await boot();
  try {
    const face = (messageId, userId, card) => groupMessage([{ type: 'face', data: { id: '13' } }], { messageId, userId, card });
    onebot.push(face(160, 100000003, 'kaguya'));
    onebot.push(face(161, 3333333333, 'iroha'));
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the repeated face');
    assert.deepEqual(sent.params.message, [{ type: 'face', data: { id: '13' } }]);
  } finally {
    await onebot.close();
  }
});


// 用例：repeatMedia: false 只停掉表情包，文字照旧跟着复读。
test('repeatMedia: false keeps text repeats but drops stickers', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', repeatMedia: false });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 170 }));
    onebot.push(groupSticker(images.url(), { messageId: 171, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupText('6', { messageId: 172 }));
    onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 173 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the text repeat'), '6');
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：表情包复读用的是环境上下文那次落盘 —— ambientMedia: false 时图不下载，也就没有复读，
// 「不为闲聊花带宽」这个承诺不能被复读偷偷破坏。
test('sticker repeat rides on the ambient download', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', ambientMedia: false });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 180 }));
    onebot.push(groupSticker(images.url(), { messageId: 181, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
    assert.equal(images.hits.length, 0);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});


// 用例：只有「一条纯文字」或「单独一张表情包」才复读 —— 图和话混着发、一条里两张图都不算。
test('only a single plain line or a single sticker is repeatable', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    const atOther = (messageId, userId) => groupMessage([{ type: 'at', data: { qq: 10001, name: 'kaguya' } }, { type: 'text', data: { text: '你好' } }], { messageId, userId, card: 'iroha' });
    const withReply = (messageId, userId) => groupMessage([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '6' } }], { messageId, userId, card: 'iroha' });
    const caption = (messageId, userId) => groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }, { type: 'text', data: { text: '笑死' } }], { messageId, userId, card: 'iroha' });
    const twoImages = (messageId, userId) => groupMessage([
      { type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } },
      { type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } },
    ], { messageId, userId, card: 'iroha' });
    for (const build of [atOther, withReply, caption, twoImages]) {
      onebot.push(build(190, 100000003));
      onebot.push(build(191, 3333333333));
    }
    await settle(300);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});
