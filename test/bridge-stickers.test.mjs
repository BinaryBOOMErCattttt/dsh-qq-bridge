/**
 * 集成测试分册：表情包目录（收藏 / 改名 / 标记 / 只认收藏目录）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-stickers.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitStickerLines } from '../onebot.js';
import { imageSegment, loadOutgoingImage } from '../image.js';
import { TINY_PNG, startImageServer, promptText, turnContextText, until, untilInbox, privateMessage, privateMessageWithImage, mention, completeTurn, sentTexts, bootImages } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';
import { buildGif } from './gif-fixtures.mjs';

after(async () => { await cleanupBoots(); });


test('loadOutgoingImage reads paths inside cwd and URLs, and refuses everything else', async () => {
  const images = await startImageServer(TINY_PNG);
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-image-'));
  try {
    await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
    await writeFile(join(cwd, '.qq-stickers', '笑死.png'), TINY_PNG);
    await writeFile(join(cwd, 'notes.txt'), 'definitely not an image');

    const local = await loadOutgoingImage({ source: '.qq-stickers/笑死.png', cwd });
    assert.equal(local.format, 'png');
    assert.deepEqual(local.bytes, TINY_PNG);
    assert.equal(local.label, '.qq-stickers/笑死.png');

    // `file://` 也认，但同样受「必须在工作目录里」的约束。
    const viaFileUrl = await loadOutgoingImage({ source: pathToFileURL(join(cwd, '.qq-stickers', '笑死.png')).href, cwd });
    assert.deepEqual(viaFileUrl.bytes, TINY_PNG);
    assert.equal(viaFileUrl.label, '.qq-stickers/笑死.png');

    // URL：插件自己先下下来（顺便校验格式），而不是把链接原样丢给 NapCat。
    const url = images.url('/meme.png');
    // 生产调用不传 allowPrivateHosts：127.0.0.1 必须先被 SSRF 判定拦下，不能真去连。
    await assert.rejects(
      () => loadOutgoingImage({ source: url, cwd }),
      /could not download.*(rejected|private|localhost)/,
    );
    assert.equal(images.hits.length, 0, '私网地址在发请求之前就被拒了');
    // 测试自己起的是本机服务，显式放开内网地址才能验下载链路。
    const remote = await loadOutgoingImage({ source: url, cwd, allowPrivateHosts: true });
    assert.equal(remote.format, 'png');
    assert.deepEqual(remote.bytes, TINY_PNG);
    assert.equal(remote.label, url);
    assert.equal(images.hits.length, 1);

    await assert.rejects(() => loadOutgoingImage({ source: '   ', cwd }), /no image given/);
    await assert.rejects(() => loadOutgoingImage({ source: 'notes.txt', cwd }), /not a PNG\/JPEG\/WebP\/GIF/);
    await assert.rejects(() => loadOutgoingImage({ source: 'no-such-file.png', cwd }), /not a local file/);
    await assert.rejects(() => loadOutgoingImage({ source: '../outside.png', cwd }), /inside the working directory/);
    await assert.rejects(() => loadOutgoingImage({ source: pathToFileURL('/etc/hostname').href, cwd }), /inside the working directory/);
    await assert.rejects(() => loadOutgoingImage({ source: 'ftp://example.com/a.png', cwd }), /unsupported image source/);
    await assert.rejects(
      () => loadOutgoingImage({ source: 'http://127.0.0.1:1/x.png', cwd, timeoutMs: 800 }),
      /could not download.*(rejected|private|localhost)/,
    );
    await assert.rejects(() => loadOutgoingImage({ source: '.qq-stickers/笑死.png', cwd, maxBytes: 10 }), /larger than 10 bytes/);

    // 段形状：base64 放在 file 里（NapCat 的发送侧按 [url, file, path] 取第一个有值的字段）。
    const segment = imageSegment(TINY_PNG);
    assert.equal(segment.type, 'image');
    assert.match(segment.data.file, /^base64:\/\//);
    assert.deepEqual(Buffer.from(segment.data.file.slice('base64://'.length), 'base64'), TINY_PNG);
    // 普通图片不带 sub_type；收藏目录里的表情带 1（QQ 的大表情 / 原创表情），
    // 不带的话群里看到的是一张照片样式的图片，一眼不像人发的表情。
    assert.equal(segment.data.sub_type, undefined);
    const sticker = imageSegment(TINY_PNG, { sticker: true });
    assert.equal(sticker.type, 'image');
    assert.equal(sticker.data.sub_type, 1);
    assert.match(sticker.data.file, /^base64:\/\//);
  } finally {
    await images.close();
    await rm(cwd, { recursive: true, force: true });
  }
});


test('已收藏的动图表情会在目录里带上分镜图（原图只有第一帧）', async () => {
  const { onebot, host, cwd } = await bootImages();
  // 模拟「这个动图在升级之前就收藏好了」：目录里本来就有它，没人再发过。
  await writeFile(join(cwd, '.qq-stickers', '转圈.gif'), buildGif({
    width: 8,
    height: 8,
    palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]],
    frames: [
      { width: 8, height: 8, indices: Array(64).fill(0), delayMs: 100 },
      { width: 8, height: 8, indices: Array(64).fill(1), delayMs: 100 },
    ],
  }));
  onebot.push(privateMessage('在吗'));
  await untilInbox(host, 1);
  // 目录行里的分镜图是后台扫出来的：等它落盘，再让下一轮重新装配目录。
  await until(async () => (await readdir(join(cwd, '.qq-media/sticker-frames')).catch(() => [])).length > 0, 'the sticker storyboard to be generated');
  onebot.push(privateMessage('再看看'));
  const agent = await untilInbox(host, 2);
  const context = await until(
    () => agent.inbox.map((message) => message.content.slice(1).map((block) => block.text ?? '').join('\n')).find((text) => text.includes('分镜图')),
    'the catalogue to point at the sticker storyboard',
  );
  const match = /转圈\.gif（2 帧）→ (\.qq-media\/sticker-frames\/[0-9a-f]{32}\.png)/.exec(context);
  assert.ok(match, context);
  const sheet = await readFile(join(cwd, match[1]));
  assert.equal(sheet.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('qq_send_image sends a sticker to the QQ conversation the calling Agent belongs to', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  // 等消息真的投进收件箱，而不是只等 Agent 被建出来：`sessionIndex`（工具据此反查
  // 「我是哪个会话的 Agent」）是在 `ensureAgent` 收尾时才写的，抢在投递之前调工具
  // 会偶发地拿不到目标（见 AGENTS §8 的 `untilInbox` 约定）。
  const agent = await untilInbox(host, 1, 'the private Agent');

  const tool = host.tools.get('qq_send_image');
  assert.ok(tool, 'qq_send_image should be registered');
  const value = await tool.execute({ image: '.qq-stickers/笑死.png' }, { agent });

  assert.equal(value.target_type, 'private');
  assert.equal(value.target_id, '100000002');
  assert.equal(value.format, 'png');
  assert.equal(value.bytes, TINY_PNG.length);
  const sent = onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message));
  assert.ok(sent, 'an image message must reach QQ');
  assert.equal(sent.params.user_id, '100000002');
  assert.equal(sent.params.message.length, 1);
  assert.equal(sent.params.message[0].type, 'image');
  // 收藏目录里的表情走「大表情」标记；`qq_send_image` 发别的图时不能带（见下一条用例）。
  assert.equal(sent.params.message[0].data.sub_type, 1);
  assert.deepEqual(Buffer.from(sent.params.message[0].data.file.replace('base64://', ''), 'base64'), TINY_PNG);
});


test('qq_send_image can send back a picture the conversation already downloaded', async () => {
  const images = await startImageServer(TINY_PNG);
  const { onebot, host } = await bootImages({ mediaDir: 'media' });
  try {
    // 「对方发了张表情包」→ 正文里给出落盘路径 → 模型把那张原样发回去。
    onebot.push(privateMessageWithImage(images.url(), { text: '你看这个' }));
    const agent = await until(() => host.list.created[0], 'the conversation Agent');
    // 入队与建 Agent 之间隔着一次下载，所以正文要等它真的进了收件箱。
    const body = await until(() => agent.inbox[0]?.content[0]?.text, 'the message body to reach the Agent');
    const path = /\[图片\(动画表情\): ([^\]]+)\]/.exec(body)?.[1];
    assert.ok(path, body);

    const value = await host.tools.get('qq_send_image').execute({ image: path }, { agent });
    assert.equal(value.source, path);
    assert.equal(value.bytes, TINY_PNG.length);
    const sent = onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message));
    assert.equal(sent.params.message[0].type, 'image');
    // `.qq-media` 里的图可能是截图或照片，绝不能标成 QQ 的大表情（会被裁成小图）。
    assert.equal(sent.params.message[0].data.sub_type, undefined);
  } finally {
    await onebot.close();
    await images.close();
  }
});


test('qq_send_image needs a target outside a QQ conversation and can post to a group', async () => {
  const { onebot, host } = await bootImages();
  const tool = host.tools.get('qq_send_image');

  await assert.rejects(() => tool.execute({ image: '.qq-stickers/笑死.png' }, {}), /target_type and target_id/);
  const value = await tool.execute({ image: '.qq-stickers/笑死.png', target_type: 'group', target_id: '100000001' }, {});
  assert.equal(value.target_type, 'group');
  assert.equal(value.target_id, '100000001');
  const sent = onebot.calls.find((call) => call.action === 'send_group_msg');
  assert.equal(sent.params.group_id, '100000001');
  assert.equal(sent.params.message[0].type, 'image');
  assert.equal(sent.params.message[0].data.sub_type, 1);
});


test('qq_send_image refuses non-images, oversized files, and paths outside cwd', async () => {
  const { onebot, host } = await bootImages({ imageMaxBytes: 32 });
  onebot.push(privateMessage('在吗'));
  await until(() => host.list.created[0], 'the conversation Agent');
  const tool = host.tools.get('qq_send_image');
  const target = { target_type: 'private', target_id: '100000002' };

  await assert.rejects(() => tool.execute({ image: 'notes.txt', ...target }, {}), /not a PNG\/JPEG\/WebP\/GIF/);
  await assert.rejects(() => tool.execute({ image: '.qq-stickers/笑死.png', ...target }, {}), /larger than 32 bytes/);
  await assert.rejects(() => tool.execute({ image: '../../etc/hostname', ...target }, {}), /inside the working directory/);
  // 一张都没发出去：校验全部发生在发消息之前。
  assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false);

  const off = await bootImages({ imageSend: false });
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  await assert.rejects(() => off.host.tools.get('qq_send_image').execute({ image: '.qq-stickers/笑死.png' }, {}), /imageSend/);
});


// ---- 存表情包：qq_save_sticker -------------------------------------------------
// 为什么需要这个工具：QQ 会话按设计没有 write / edit / bash（那三样在不可信输入面上
// 太危险），于是群里最常见的那句「存一下这个表情」模型**自己做不到**。真实发生过的
// 样子是它 `read_image` 看完、`glob .qq-stickers/**` 发现空的，只能把含义追加进
// `COGNITION.md`、key 写成 `.qq-media/<内容哈希>`（一个会被淘汰的缓存路径），然后回一句
// 「存好了」。这一组钉住的是：存下去的是**原字节**、名字被洗成单层、目录满了/同名了会拒绝，
// 以及存完下一轮提示词里就能挑到它。

test('qq_save_sticker keeps a picture the conversation posted and it shows up in the pack', async () => {
  const images = await startImageServer(TINY_PNG);
  const { onebot, host, cwd } = await bootImages();
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '存一下这个' }));
    const agent = await until(() => host.list.created[0], 'the conversation Agent');
    const body = await until(() => agent.inbox[0]?.content[0]?.text, 'the message body to reach the Agent');
    const source = /\[图片\(动画表情\): ([^\]]+)\]/.exec(body)?.[1];
    assert.ok(source, body);

    const value = await host.tools.get('qq_save_sticker').execute({ source, name: '委屈', meaning: '委屈、求安慰' }, { agent });
    assert.equal(value.path, '.qq-stickers/委屈.png');
    assert.equal(value.format, 'png');
    assert.equal(value.bytes, TINY_PNG.length);
    // 落盘的必须是原字节：这张图以后要原样发回去，转码过就不是同一张表情了。
    assert.deepEqual(await readFile(join(cwd, '.qq-stickers', '委屈.png')), TINY_PNG);
    // 目录变了之后**下一轮的情境**里就能挑到它（不放进系统提示：存一张表情不该让整份
    // 人设 + 硬规则再追加一遍，见下面「表情包目录变了不改系统提示」那条）。
    // 条目必须带上**完整路径**：只给名字的话模型会自己猜扩展名
    //（真实事故：敲盆.gif 被写成敲盆.jpg，发送侧找不到）。
    const channel = promptText(host, 'qq-bridge:channel');
    onebot.push(privateMessage('刚存的那张以后能用上吧'));
    await untilInbox(host, 2, 'the next turn after saving');
    assert.match(turnContextText(agent), /委屈（委屈、求安慰） → \.qq-stickers\/委屈\.png/);
    assert.equal(promptText(host, 'qq-bridge:channel'), channel, '系统提示一个字都不能变');
    // 存下来的唯一用途就是发出去：裸文件名（不带扩展名）也该认得出来。
    const sent = await host.tools.get('qq_send_image').execute({ image: '委屈' }, { agent });
    assert.equal(sent.source, '.qq-stickers/委屈.png');
  } finally {
    await onebot.close();
    await images.close();
  }
});


/**
 * 表情包目录是系统提示里最后一块**会变**的内容：存一张图 / 改个名，提示词就差几个字，
 * 而 DSH 会把整段 7.5k 字的人设 + 表达契约 + 硬性规则当新的 system 消息再追加一份
 *（2026-10-21 群名那 6 个字的真实事故）。所以它跟着「本轮情境」走：本会话第一次给一次、
 * 目录变了补一次、其余轮次一个字不发。
 */
test('the sticker catalogue rides on the turn context and never rewrites the system prompt', async () => {
  const { onebot, host, cwd } = await bootImages();
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the first turn');
    const first = promptText(host, 'qq-bridge:channel');
    assert.ok(turnContextText(agent).includes('.qq-stickers/笑死.png'), '第一次要把目录给一次');
    assert.ok(!first.includes('.qq-stickers/笑死.png'), '目录内容不进系统提示');

    // 存一张新表情：`stickerNames()` 读到它就算「目录变了」，与 qq_save_sticker 写完等价。
    await writeFile(join(cwd, '.qq-stickers', '委屈.png'), TINY_PNG);
    onebot.push(privateMessage('还在吗'));
    await untilInbox(host, 2, 'the second turn');
    assert.equal(promptText(host, 'qq-bridge:channel'), first, '系统小节必须逐字不变');
    assert.ok(turnContextText(agent).includes('.qq-stickers/委屈.png'), '新表情在下一轮补一次');

    onebot.push(privateMessage('第三句'));
    await untilInbox(host, 3, 'the third turn');
    assert.ok(!turnContextText(agent).includes('.qq-stickers/'), '目录没变就不再重复');
  } finally {
    await onebot.close();
  }
});


test('qq_save_sticker refuses non-images, outside paths, unusable names, and overwrites', async () => {
  const { onebot, host, cwd } = await bootImages();
  try {
    const tool = host.tools.get('qq_save_sticker');
    await assert.rejects(() => tool.execute({ source: 'notes.txt', name: '笔记' }, {}), /not a PNG\/JPEG\/WebP\/GIF/);
    await assert.rejects(() => tool.execute({ source: '../../etc/hostname', name: '越界' }, {}), /inside the working directory/);
    // 名字清洗完什么都不剩时必须报错，而不是写一个 `.png` 这种残名进去。
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '..' }, {}), /not a usable sticker name/);
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '\u0000' }, {}), /not a usable sticker name/);
    // 同名**绝不覆盖**：不然群里任何人一句「存一下」就能把现有表情换掉。
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '笑死' }, {}), /already exists/);
    // 一次都没写成功：所有校验都发生在动目录之前。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['笑死.png']);
  } finally {
    await onebot.close();
  }
});


test('qq_save_sticker stops at imageMaxBytes and at stickerMaxFiles', async () => {
  // 太大的图先被 imageMaxBytes 挡住（与发图同一条校验）。
  const big = await bootImages({ imageMaxBytes: 32 });
  await assert.rejects(() => big.host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '大图' }, {}), /larger than 32 bytes/);
  await big.onebot.close();

  // 目录里已经有 1 张、上限也是 1：QQ 那头能一直让它存，所以必须在这里截断。
  const capped = await bootImages({ stickerMaxFiles: 1 });
  try {
    await assert.rejects(
      () => capped.host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '再一张' }, {}),
      /already holds 1 images/,
    );
  } finally {
    await capped.onebot.close();
  }
});


test('qq_save_sticker is not registered when the sticker directory or its whitelist slot is missing', async () => {
  // 目录配到 cwd 外 = 表情包功能整体停用（只记 warn）：不给模型一个必然报错的工具。
  const outside = await bootImages({ stickerDir: '../stickers' });
  try {
    outside.onebot.push(privateMessage('在吗'));
    await until(() => outside.host.list.created[0], 'the outside Agent');
    assert.equal(outside.host.tools.get('qq_save_sticker'), undefined);
    assert.doesNotMatch(promptText(outside.host, 'qq-bridge:channel'), /qq_save_sticker/);
  } finally {
    await outside.onebot.close();
  }

  // 白名单里没有它（这里只给 read）时同样不注册 —— 白名单只能收窄，漏一层就等于没收。
  const restricted = await bootImages({ allowTools: ['read'] }, { knownTools: ['read', 'qq_send_image', 'qq_save_sticker'] });
  try {
    restricted.onebot.push(privateMessage('在吗'));
    await until(() => restricted.host.list.created[0], 'the restricted Agent');
    assert.equal(restricted.host.tools.get('qq_save_sticker'), undefined);
    assert.doesNotMatch(promptText(restricted.host, 'qq-bridge:channel'), /qq_save_sticker/);
  } finally {
    await restricted.onebot.close();
  }
});


// ---- 给表情包改名：qq_rename_sticker -------------------------------------------
// 这个工具的来历就是一条真实事故：模型想改一张表情的名字 / 含义时，手上只有
// `qq_save_sticker` 这一条写盘通道，于是它把同一张图**换个名字再存一遍** ——
// `.qq-stickers/` 里多出一张同画面、不同名的重复表情，`STICKERS.md` 里旧名字那条
// 还留着，两张以后都会被挑中，而它自己没有删文件的通道。改名必须是「同一个文件换
// 个名字、目录那一条跟着搬」，这一组钉住的就是：文件真的搬了、目录没有旧条目、
// 含义 / 场景 / 日期不丢、目标名占用时拒绝、失败时不留半套。

test('qq_rename_sticker moves the file and its catalogue row together', async () => {
  const { onebot, host, cwd } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');
  try {
    const save = host.tools.get('qq_save_sticker');
    await save.execute({ source: '.qq-stickers/笑死.png', name: '委屈', meaning: '委屈、求安慰', scene: '对方凶我时' }, { agent });

    const renamed = await host.tools.get('qq_rename_sticker').execute({ from: '委屈', to: '难过' }, { agent });
    assert.equal(renamed.previous, '.qq-stickers/委屈.png');
    assert.equal(renamed.path, '.qq-stickers/难过.png');
    assert.equal(renamed.renamed, true);
    assert.equal(renamed.bytes, TINY_PNG.length);
    // 文件是**搬过去**的：旧名字不在了，也不该多出一张同画面的副本。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['笑死.png', '难过.png']);
    assert.deepEqual(await readFile(join(cwd, '.qq-stickers', '难过.png')), TINY_PNG, '改的是名字，不是字节');
    // 目录那一条跟着搬：含义 / 场景 / 路径都在新名字下，旧名字一条不剩。
    // 看的是**下一轮的情境**（目录变了才补一次，系统提示不动）。
    onebot.push(privateMessage('改名之后能用了吧'));
    await untilInbox(host, 2, 'the next turn after renaming');
    const catalog = turnContextText(agent);
    assert.match(catalog, /难过（委屈、求安慰） → \.qq-stickers\/难过\.png/);
    assert.doesNotMatch(catalog, /委屈（/);
    assert.doesNotMatch(promptText(host, 'qq-bridge:channel'), /难过（委屈/);
    // 发图那条路认得新名字（旧名字的裸名字解析已经不指向任何文件）。
    const sent = await host.tools.get('qq_send_image').execute({ image: '难过' }, { agent });
    assert.equal(sent.source, '.qq-stickers/难过.png');
    // 旧名字再改一次就该明确报错（而不是悄悄追加一条新的）。
    await assert.rejects(() => host.tools.get('qq_rename_sticker').execute({ from: '委屈', to: '更难过' }, { agent }), /没有「委屈」/);
  } finally {
    await onebot.close();
  }
});


test('qq_rename_sticker refuses taken names and unusable names', async () => {
  const { onebot, host, cwd } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');
  try {
    const rename = () => host.tools.get('qq_rename_sticker');
    // 改成同一个名字是空操作（不报错，也不该搬文件）。
    const same = await rename().execute({ from: '笑死', to: '笑死' }, { agent });
    assert.equal(same.renamed, false);
    await host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '委屈', meaning: '委屈、求安慰' }, { agent });
    // 目标名已被占用（目录里本来就有 笑死.png）：与「同名不覆盖」同一条理由。
    await assert.rejects(() => rename().execute({ from: '委屈', to: '笑死' }, { agent }), /already exists/);
    // 名字清洗完什么都不剩：必须报错，而不是搬成 `.png`。
    await assert.rejects(() => rename().execute({ from: '委屈', to: '..' }, { agent }), /not a usable sticker name/);
    // 找不到来源：说清目录里有哪些，别让模型去猜。
    await assert.rejects(() => rename().execute({ from: '不存在的表情', to: '新名字' }, { agent }), /没有「不存在的表情」/);
    // 一次都没动过目录。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['委屈.png', '笑死.png']);
    // 存进去的那一条在下一轮的情境里（系统提示不动，见「表情包目录变了」那条）。
    onebot.push(privateMessage('再看一眼目录'));
    await untilInbox(host, 2, 'the next turn');
    assert.match(turnContextText(agent), /委屈（委屈、求安慰） → \.qq-stickers\/委屈\.png/);
  } finally {
    await onebot.close();
  }
});


test('qq_rename_sticker is not registered without the sticker directory or its whitelist slot', async () => {
  const outside = await bootImages({ stickerDir: '../stickers' });
  try {
    outside.onebot.push(privateMessage('在吗'));
    await until(() => outside.host.list.created[0], 'the outside Agent');
    assert.equal(outside.host.tools.get('qq_rename_sticker'), undefined);
    assert.doesNotMatch(promptText(outside.host, 'qq-bridge:channel'), /qq_rename_sticker/);
  } finally {
    await outside.onebot.close();
  }

  // 只整理不新增：存图关掉、改名单独放开 —— 白名单是逐名字的，不应该被别的工具连坐。
  const restricted = await bootImages(
    { allowTools: ['read', 'qq_send_image', 'qq_rename_sticker'] },
    { knownTools: ['read', 'qq_send_image', 'qq_save_sticker', 'qq_rename_sticker'] },
  );
  try {
    restricted.onebot.push(privateMessage('在吗'));
    await until(() => restricted.host.list.created[0], 'the rename-only Agent');
    assert.equal(restricted.host.tools.get('qq_save_sticker'), undefined);
    assert.ok(restricted.host.tools.get('qq_rename_sticker'), '改名不该被存图的白名单连坐');
  } finally {
    await restricted.onebot.close();
  }
});


test('the channel prompt offers qq_send_image and the sticker rules, and the pack rides on the turn context', async () => {
  const on = await bootImages();
  on.onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(on.host, 1, 'the first Agent');
  const prompt = promptText(on.host, 'qq-bridge:channel');
  assert.match(prompt, /qq_send_image/);
  // 「存一下这个」是群里最常出现的一句，提示词必须把那条窄通道说清楚。
  assert.match(prompt, /qq_save_sticker/);
  // 目录**内容**不在系统提示里（它每存一张就变，会让整份人设再追加一遍），在「本轮情境」。
  assert.doesNotMatch(prompt, /\.qq-stickers\/笑死\.png/);
  assert.match(turnContextText(agent), /\.qq-stickers\/笑死\.png/);

  // 白名单挡掉这个工具时，提示词里一个字都不能再提它。
  const off = await bootImages(
    { allowTools: ['read'] },
    { knownTools: ['qq_send_message', 'qq_send_image', 'qq_list_conversations', 'read'] },
  );
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  const hidden = promptText(off.host, 'qq-bridge:channel');
  assert.doesNotMatch(hidden, /qq_send_image/);
  assert.doesNotMatch(hidden, /qq_save_sticker/);
  assert.doesNotMatch(hidden, /笑死\.png/);
});


test('a sticker directory outside cwd is not advertised', async () => {
  const { onebot, host } = await bootImages({ stickerDir: '../stickers' });
  onebot.push(privateMessage('在吗'));
  await until(() => host.list.created[0], 'the Agent');
  assert.ok(host.list.warnings.some((line) => line.includes('outside cwd')), host.list.warnings.join('|'));
  const prompt = promptText(host, 'qq-bridge:channel');
  // 工具照样在（发工作目录里的图不受影响），但那个读不到的目录不该被列出来。
  assert.match(prompt, /qq_send_image/);
  assert.doesNotMatch(prompt, /stickers\//);
});


// ---- 只发表情：回复正文里的 `[[图片: …]]` 标记 ---------------------------------
// 工具调用发生在整轮文字之前，而且「一个字都不说」用工具表达不出来（模型总得写点什么）。
// 所以表情写成正文里的一处标记：位置跟着正文走，整条回复只有这一处时就是一条文字都不发。

test('splitStickerLines turns sticker markers into image pieces and keeps the text order', () => {
  assert.deepEqual(splitStickerLines(''), []);
  assert.deepEqual(splitStickerLines('  \n '), []);
  assert.deepEqual(splitStickerLines('[[图片: a.png]]'), [{ kind: 'image', source: 'a.png', raw: '[[图片: a.png]]' }]);
  // 关键字写法与全角冒号、空格都认
  assert.deepEqual(splitStickerLines('[[ 表情包 ： b.gif ]]'), [{ kind: 'image', source: 'b.gif', raw: '[[ 表情包 ： b.gif ]]' }]);
  // 混在正文里也认，顺序不变
  assert.deepEqual(splitStickerLines('你好\n[[图片: a.png]]\n再见'), [
    { kind: 'text', text: '你好' },
    { kind: 'image', source: 'a.png', raw: '[[图片: a.png]]' },
    { kind: 'text', text: '再见' },
  ]);
  // 认不出来的方括号一律当普通文字：宁可在群里露出这行字，也不要静默吞掉。
  assert.deepEqual(splitStickerLines('[[图片: ]]'), [{ kind: 'text', text: '[[图片: ]]' }]);
  assert.deepEqual(splitStickerLines('[[音频: a.mp3]]'), [{ kind: 'text', text: '[[音频: a.mp3]]' }]);
});


test('a reply that is only a sticker marker sends one image and no text at all', async () => {
  // humanize 不该影响这件事：拆条拆的是文字，表情本来就只有一条。
  for (const humanize of [true, false]) {
    const { onebot, host } = await bootImages({ humanize });
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');

    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message)),
      'the sticker to reach QQ',
    );
    assert.equal(sent.params.user_id, '100000002');
    assert.equal(sent.params.message.length, 1);
    assert.equal(sent.params.message[0].type, 'image');
    // 收藏目录里的表情按 QQ 的「大表情」发（真人从表情面板发出来的那些也是这样）。
    assert.equal(sent.params.message[0].data.sub_type, 1);
    assert.deepEqual(Buffer.from(sent.params.message[0].data.file.replace('base64://', ''), 'base64'), TINY_PNG);
    // 一条文字都没有：整轮只发了这一条。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(onebot.calls.filter((call) => call.action === 'send_private_msg').length, 1);
    await onebot.close();
  }
});


test('a sticker written as a bare file name or with the wrong extension is still found', async () => {
  // 提示词里给的是 `.qq-stickers/笑死.png`，但模型很可能只写 `笑死` / `笑死.png`，
  // 或者把扩展名猜错（目录里 .jpg 比 .gif 多，真实事故：敲盆.gif 被写成敲盆.jpg）。
  // 落空的话群里只会看到一句「表情包没发出去」，所以这些写法都先在表情包目录里找回来。
  for (const source of ['笑死', '笑死.png', '.qq-stickers/笑死.png', '笑死.gif', '.qq-stickers/笑死.gif']) {
    const { onebot, host } = await bootImages();
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');

    completeTurn(host, agent, `[[图片: ${source}]]`);
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message)),
      `the sticker written as ${source} to reach QQ`,
    );
    assert.equal(sent.params.message[0].type, 'image');
    assert.equal(onebot.calls.filter((call) => call.action === 'send_private_msg' && typeof call.params.message === 'string').length, 0);
    // 工具那边同一套解析。
    const viaTool = await host.tools.get('qq_send_image').execute({ image: source }, { agent });
    assert.equal(viaTool.source, '.qq-stickers/笑死.png');
    await onebot.close();
  }
});


test('a sticker marker inside a reply keeps its place between the text parts', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '先说我一句\n[[图片: .qq-stickers/笑死.png]]\n再补一句');
  const calls = await until(() => {
    const sent = onebot.calls.filter((call) => call.action === 'send_private_msg');
    return sent.length >= 3 ? sent : undefined;
  }, 'the three messages');
  assert.equal(calls[0].params.message, '先说我一句');
  assert.equal(calls[1].params.message[0].type, 'image');
  assert.equal(calls[2].params.message, '再补一句');
});


test('an image never carries the reply target, and a sticker-only reply drops the quote', async () => {
  // §6.6：引用只挂第一个**文字**气泡，图段永不挂；整轮只有图时引用直接丢弃。
  // 「表情本身就是一个反应」，给它挂一条引用反而像在慎重地回复某句话。
  const { onebot, host } = await bootImages({ replyStyle: 'quote' }, {}, {});
  onebot.push(mention('来一张'));
  const agent = await untilInbox(host, 1, 'the group Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
  const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the group message');
  assert.equal(sent.params.message.length, 1, '只有图，没有任何前面挂的段');
  assert.equal(sent.params.message[0].type, 'image');
});


test('a sticker that cannot be sent says so instead of going silent', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/nope.png]]');
  const sent = await until(
    () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('发不出去')),
    'the notice to reach QQ',
  );
  assert.match(sent, /发不出去/);
  // 一张图都没发出去。
  assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
  assert.ok(host.list.warnings.some((line) => line.includes('nope.png')), host.list.warnings.join('|'));
  // 失败必须回灌到**下一轮的情境**里：模型才看得到「那张没发出去、为什么」，
  // 否则它会照着自己编的路径再编一个（真实事故：连编两轮 `.qq-media` 哈希）。
  onebot.push(privateMessage('再试一次'));
  await untilInbox(host, 2, 'the follow-up turn');
  const prompt = turnContextText(agent);
  assert.match(prompt, /nope\.png/);
  assert.match(prompt, /没发出去/);
});


test('发表情只认收藏目录：`.qq-media` 里真实存在的图也不能借标记发出去', async () => {
  const { onebot, host, cwd } = await bootImages();
  // 造一张**真实存在**的缓存图：旧事故里模型编的路径根本不存在，这里要证明的是
  // 「就算存在也不许发」—— 否则它迟早会挑到一张已经被人删掉的。
  await mkdir(join(cwd, '.qq-media'), { recursive: true });
  await writeFile(join(cwd, '.qq-media', 'abc123.png'), TINY_PNG);
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '[[图片: .qq-media/abc123.png]]');
  const sent = await until(
    () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('发不出去')),
    'the refusal notice',
  );
  assert.match(sent, /发不出去/);
  assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false, '一张图都不该发出去');
  onebot.push(privateMessage('再试一次'));
  await untilInbox(host, 2, 'the follow-up turn');
  const prompt = turnContextText(agent);
  assert.match(prompt, /只能从收藏目录/);
});


test('the marker stays literal text when image sending is off or whitelisted away', async () => {
  const cases = [
    { config: { imageSend: false }, hostOptions: {} },
    { config: { allowTools: ['read'] }, hostOptions: { knownTools: ['qq_send_image', 'read'] } },
  ];
  for (const { config, hostOptions } of cases) {
    const { onebot, host } = await bootImages(config, hostOptions);
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');
    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const text = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the literal line');
    assert.equal(text, '[[图片: .qq-stickers/笑死.png]]');
    assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
    assert.doesNotMatch(promptText(host, 'qq-bridge:channel'), /\[\[图片/);
  }
});
