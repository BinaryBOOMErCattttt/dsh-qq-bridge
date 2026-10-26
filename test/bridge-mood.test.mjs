/**
 * 端到端：心情门控 + 斗图模式。
 *
 * 钉住四件事：
 *   1. 心情没满时，正文里的表情标记被丢掉；模型无法绕过门控发表情。
 *   2. 模型用 [[mood:upN]] 打分，满阈值后下一轮放行一次，发出去之后清零。
 *   3. qq_send_image 的 user_requested 能放行一次；没放行时明确报错。
 *   4. 斗图模式：表情常驻、目录每轮都在、开场只读一次 SEMANTICS、退出后模式落盘。
 *
 * 夹具在 test/harness.mjs；本文件只放这一主题的用例，可单独跑：
 * node --test test/bridge-mood.test.mjs
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIVATE_USER_ID,
  SELF_ID,
  TINY_PNG,
  boot,
  cleanupBoots,
  completeTurn,
  pokeNotice,
  privateMessage,
  promptText,
  sentTexts,
  settle,
  turnContextText,
  until,
  untilInbox,
} from './harness.mjs';

after(async () => { await cleanupBoots(); });

const OWNER = String(PRIVATE_USER_ID);
const MOOD_KEY = 'private:' + PRIVATE_USER_ID;

/** 起一个带一张表情的实例（门控保持默认开）。 */
async function bootSticker(config = {}, mode) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-mood-cwd-'));
  await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
  await writeFile(join(cwd, '.qq-stickers', '笑死.png'), TINY_PNG);
  if (mode !== undefined) {
    await mkdir(join(cwd, 'data'), { recursive: true });
    await writeFile(join(cwd, 'data', 'mode.json'), JSON.stringify({ mode, at: Date.now() }), 'utf8');
  }
  const booted = await boot({ cwd, ...config });
  return { ...booted, cwd };
}

/** 私聊里发出去的图片调用。 */
function sentImages(onebot) {
  return onebot.calls.filter((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message))
    .filter((call) => call.params.message.some((segment) => segment.type === 'image'));
}

/** 等聊天账本落盘到满足条件（save 有 500ms 合并窗口）。 */
async function moodState(cwd, check) {
  return until(async () => {
    const parsed = JSON.parse(await readFile(join(cwd, 'data', 'chat-state.json'), 'utf8').catch(() => '{}'));
    const mood = parsed.mood?.[MOOD_KEY];
    return mood !== undefined && check(mood) ? mood : undefined;
  }, 'the mood state to be written');
}

test('心情没满时，正文里的表情标记被丢掉（不靠提示词自觉）', async () => {
  const { onebot, host } = await bootSticker();
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the first private turn');
    assert.match(promptText(host, 'qq-bridge:channel'), /表情权限默认关闭/);
    assert.match(promptText(host, 'qq-bridge:channel'), /user_requested/);

    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    await settle(150);
    assert.equal(sentImages(onebot).length, 0, '门控没放行时一张图都不该发出去');
  } finally {
    await onebot.close();
  }
});

test('心情 tag 满阈值后放行一次，发出去之后清零', async () => {
  const { onebot, host, cwd } = await bootSticker();
  try {
    onebot.push(privateMessage('你好可爱'));
    const agent = await untilInbox(host, 1, 'the first private turn');
    completeTurn(host, agent, '嘿嘿 [[mood:up100]]');
    await until(() => sentTexts(onebot, 'send_private_msg').includes('嘿嘿'), 'the reply without the mood tag');
    assert.equal(sentTexts(onebot, 'send_private_msg').some((text) => text.includes('mood:')), false, 'tag 不能发给用户');
    await moodState(cwd, (mood) => mood.grant === true && mood.score === 100);

    // 下一轮：本轮情境里必须说明「这次已放行」，系统提示保持不变。
    onebot.push(privateMessage('那发张表情'));
    await untilInbox(host, 2, 'the second private turn');
    assert.match(turnContextText(agent), /这次表情权限已放行/);
    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]', 2);
    await until(() => sentImages(onebot).length === 1, 'the released sticker');
    await moodState(cwd, (mood) => mood.grant === false && mood.score === 0);

    // 许可用掉之后又回到默认关闭。
    onebot.push(privateMessage('再来一张'));
    await untilInbox(host, 3, 'the third private turn');
    assert.doesNotMatch(turnContextText(agent), /这次表情权限已放行/);
  } finally {
    await onebot.close();
  }
});

test('qq_send_image：user_requested 放行一次，没放行且心情没满时明确拒绝', async () => {
  const { onebot, host } = await bootSticker();
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the private Agent');
    const tool = host.tools.get('qq_send_image');
    await assert.rejects(() => tool.execute({ image: '.qq-stickers/笑死.png' }, { agent }), /表情权限没开/);
    assert.equal(sentImages(onebot).length, 0);

    const sent = await tool.execute({ image: '.qq-stickers/笑死.png', user_requested: true }, { agent });
    assert.equal(sent.source, '.qq-stickers/笑死.png');
    assert.equal(sentImages(onebot).length, 1, '用户明确要表情时放行一次');
  } finally {
    await onebot.close();
  }
});

test('斗图模式：表情常驻、目录每轮都在、开场只读一次，连发提醒会计数', async () => {
  const { onebot, host } = await bootSticker({}, 'sticker');
  try {
    onebot.push(privateMessage('来斗图'));
    const agent = await untilInbox(host, 1, 'the first sticker turn');
    const prompt = promptText(host, 'qq-bridge:channel');
    assert.match(prompt, /斗图模式一直有效/);
    assert.match(prompt, /默认每条回复都带一张表情/);
    const first = turnContextText(agent);
    assert.match(first, /斗图模式（本轮开场）/);
    assert.match(first, /SEMANTICS\.md/);
    assert.match(first, /\.qq-stickers\/笑死\.png/, '目录要在开场就在眼前');

    // 只回文字：这一轮记一次「没发图」。
    completeTurn(host, agent, '哈哈哈');
    await until(() => sentTexts(onebot, 'send_private_msg').includes('哈哈哈'), 'the text-only reply');

    onebot.push(privateMessage('继续'));
    await untilInbox(host, 2, 'the second sticker turn');
    const second = turnContextText(agent);
    assert.match(second, /已经连续 1 轮没有发表情/);
    assert.doesNotMatch(second, /本轮开场/, '开场提示只喂一轮');
    assert.match(second, /\.qq-stickers\/笑死\.png/, '斗图模式每轮都要给目录');

    // 这一轮带图：不该再被心情门控拦下，也不消耗心情。
    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]', 2);
    await until(() => sentImages(onebot).length === 1, 'the sticker sent without a mood grant');

    onebot.push(privateMessage('再来'));
    await untilInbox(host, 3, 'the third sticker turn');
    assert.doesNotMatch(turnContextText(agent), /已经连续/);
    assert.match(turnContextText(agent), /\.qq-stickers\/笑死\.png/);
  } finally {
    await onebot.close();
  }
});

test('模式 斗图：主人能切、落盘、下一轮带上斗图提示词', async () => {
  const { onebot, host, cwd } = await bootSticker({
    resetUsers: [OWNER],
    ownerAutoClaim: false,
    pokeMode: 'text',
    pokeCooldownMs: 0,
    pokeDailyMax: 0,
  });
  try {
    onebot.push(privateMessage('模式 斗图'));
    const confirmation = await until(
      () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('已切到斗图模式')),
      'the sticker-mode confirmation',
    );
    assert.match(confirmation, /表情发送常驻/);
    const saved = JSON.parse(await readFile(join(cwd, 'data', 'mode.json'), 'utf8'));
    assert.equal(saved.mode, 'sticker');

    onebot.push(pokeNotice({ userId: PRIVATE_USER_ID, targetId: SELF_ID }));
    const agent = await untilInbox(host, 1, 'the Agent after switching to sticker mode');
    assert.match(promptText(host, 'qq-bridge:channel'), /斗图模式一直有效/);
    assert.match(turnContextText(agent), /本轮开场/);
  } finally {
    await onebot.close();
  }
});
