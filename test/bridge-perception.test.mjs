/**
 * 集成测试分册：感知（戳一戳 / 链接预览 / 视频封面 / 语音占位）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-perception.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { TINY_PNG, startImageServer, until, untilInbox, privateMessage, boot, settle, pokeNotice } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


test('戳一戳：回戳那个戳它的人，冷却之内不再重复', async () => {
  const { onebot, host } = await boot({ pokeMode: 'poke', pokeCooldownMs: 60_000 });
  onebot.push(pokeNotice());
  const poke = await until(() => onebot.calls.find((call) => call.action === 'send_poke'), 'the poke back');
  // 回戳只打给戳它的人（user_id），从不打给别人。
  assert.equal(String(poke.params.user_id), '100000002');
  // 冷却期里再戳几下也只回一次 —— 防两个机器人互戳的关键一道闸。
  onebot.push(pokeNotice());
  onebot.push(pokeNotice());
  await settle(120);
  assert.equal(onebot.calls.filter((call) => call.action === 'send_poke').length, 1);
  await onebot.close();
});


test('戳一戳：只回应戳机器人的，别人互相戳不关它的事', async () => {
  const { onebot } = await boot({ pokeMode: 'poke' });
  onebot.push(pokeNotice({ userId: 10001, targetId: 10002, groupId: 100000001 }));
  await settle(120);
  assert.equal(onebot.calls.filter((call) => call.action === 'send_poke').length, 0);
  await onebot.close();
});


test('戳一戳：pokeMode text 走一轮模型，正文说清「不是正式提问」并给 SKIP 出口', async () => {
  const { onebot, host } = await boot({ pokeMode: 'text' });
  onebot.push(pokeNotice());
  const agent = await untilInbox(host, 1, 'the poke turn');
  const text = agent.inbox[0].content[0].text;
  assert.match(text, /戳了你一下/);
  assert.match(text, /SKIP/);
  // 戳一戳不是「插件自作主张」：这句话本来就是转告一个真人动作，说明来源反而更清楚。
  assert.match(text, /不是正式提问/);
  await onebot.close();
});


test('linkPreview：打开后把裸 URL 换成「标题 + 域名」，内网地址默认不抓', async () => {
  const page = await startImageServer(Buffer.from('<html><head><title>示例标题</title></head></html>'), {
    contentType: 'text/html; charset=utf-8',
  });
  try {
    const off = await boot({ linkPreview: false });
    off.onebot.push(privateMessage(`看这个 ${page.url()}/a`));
    const offAgent = await untilInbox(off.host, 1, 'the url message without preview');
    assert.match(offAgent.inbox[0].content[0].text, /https?:\/\/127\.0\.0\.1/);
    assert.equal(page.hits.length, 0, '默认关时一个请求都不该发');
    await off.onebot.close();

    const on = await boot({ linkPreview: true, linkAllowPrivateHosts: true });
    on.onebot.push(privateMessage(`看这个 ${page.url()}/b`));
    const onAgent = await untilInbox(on.host, 1, 'the url message with preview');
    assert.match(onAgent.inbox[0].content[0].text, /\[链接: 【示例标题】/);
    assert.ok(page.hits.includes('/image/b'), `server hits: ${page.hits.join(',')}`);
    await on.onebot.close();
  } finally {
    await page.close();
  }
});


test('视频只下封面：正文给出时长与封面路径，整段不下载', async () => {
  const cover = await startImageServer(TINY_PNG);
  try {
    const { onebot, host } = await boot({ videoCover: true });
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'video', data: { duration: 12, thumb: cover.url('/thumb') } }],
    });
    const agent = await untilInbox(host, 1, 'the video message');
    const text = agent.inbox[0].content[0].text;
    assert.match(text, /\[视频 12 秒 · 封面: \.qq-media\/[0-9a-f]+\.png\]/);
    assert.ok(cover.hits.includes('/thumb'));
    await onebot.close();
  } finally {
    await cover.close();
  }
});


test('语音只做时长占位：不下载文件、也不起任何进程', async () => {
  const { onebot, host } = await boot();
  onebot.push({
    post_type: 'message',
    message_type: 'private',
    user_id: 100000002,
    sender: { nickname: 'iroha' },
    message: [{ type: 'record', data: { duration: 3, file: 'abc.amr', url: 'https://example.invalid/x.amr' } }],
  });
  const agent = await untilInbox(host, 1, 'the voice message');
  assert.equal(agent.inbox[0].content[0].text, '[语音 3 秒]');
  await onebot.close();
});
