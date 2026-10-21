/**
 * 集成测试分册：人设与提示词槽位。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-persona.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promptText, turnContextText, untilInbox, privateMessage, mention, boot, bootWithPersona } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


test('PERSONA.md 优先于配置 persona，且按场景选段', async () => {
  const group = await bootWithPersona({ persona: '配置里那段人设' });
  try {
    group.onebot.push(mention('在吗'));
    const agent = await untilInbox(group.host, 1, 'the group Agent');
    const prompt = promptText(group.host, 'qq-bridge:channel');
    const context = turnContextText(agent);
    assert.match(prompt, /【身份】名字：小栞/);
    assert.match(prompt, /【底色｜始终在场】别人难受时 → 温柔/);
    assert.match(context, /【本轮场景｜群聊】群聊场景标记/);
    assert.doesNotMatch(context, /私聊场景标记/, '群聊轮不该带私聊的场景段');
    assert.doesNotMatch(prompt, /配置里那段人设/, '文件存在时配置 persona 被忽略（不叠加）');
    assert.equal(agent.inbox.length, 1);
    // 表达契约来自 STYLE.md；不认识的节（`## 语气`）内容也要并进「总体」生效。
    assert.match(prompt, /表达文件标记/);
    assert.match(prompt, /语气节标记/);
    assert.match(prompt, /群聊表达标记/);
    // 「行，」这类应答开场在硬性规则里：STYLE.md 没写它，也删不掉它。
    const hardRulesAt = prompt.indexOf('硬性要求（最高优先级');
    assert.ok(hardRulesAt >= 0);
    assert.ok(
      prompt.indexOf('这类应答开场') > hardRulesAt,
      '应答开场禁令属于硬性规则，STYLE.md 删不掉',
    );
    // 空格断句（「才没有 是你没跟上我」）同样是排版地板：STYLE.md 删掉那一条也还留在这里。
    assert.ok(
      prompt.indexOf('不许拿空格当标点') > hardRulesAt,
      '空格不是标点的禁令属于硬性规则，STYLE.md 删不掉',
    );
    // 专名不自己音译同样是硬性规则：快模型会用英文原名现翻一个「听起来像」的中文。
    assert.ok(
      prompt.indexOf('别自己音译') > hardRulesAt,
      '专名不自己音译的禁令属于硬性规则，STYLE.md 删不掉',
    );
    // 「金句」也是人机感地板：真实投诉里那四种句式（这事我认 / 是 X 也是真 X / 不过说实话 /
    // 打分 + 编数字）必须写在硬性规则里，部署者删掉 STYLE.md 里那一条也还留在这里。
    assert.ok(
      prompt.indexOf('别把回话收成') > hardRulesAt,
      '「不要把回话收成金句」的禁令属于硬性规则，STYLE.md 删不掉',
    );
  } finally {
    await group.onebot.close();
  }

  // 私聊轮选私聊那段场景。
  const priv = await bootWithPersona();
  try {
    priv.onebot.push(privateMessage('在吗'));
    await untilInbox(priv.host, 1, 'the private Agent');
    const prompt = promptText(priv.host, 'qq-bridge:channel');
    const context = turnContextText(priv.host.list.created[0]);
    assert.match(context, /【本轮场景｜私聊】私聊场景标记/);
    assert.doesNotMatch(context, /群聊场景标记/);
  } finally {
    await priv.onebot.close();
  }
});


test('提示词槽位：硬性规则在最后（最高优先级），且表达契约在记忆之前', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    await untilInbox(host, 1, 'the Agent');
    const prompt = promptText(host, 'qq-bridge:channel');
    const at = (needle) => {
      const index = prompt.indexOf(needle);
      assert.ok(index >= 0, `提示词里应当有「${needle}」`);
      return index;
    };
    // 顺序：场景/人设 → 表达契约 → 记忆 → 能力 → **硬性要求（最后）**。
    assert.ok(at('怎么说话（表达契约）') < at('硬性要求（最高优先级'));
    assert.ok(at('硬性要求（最高优先级') > at('需要主动给其他人或群发消息'));
    assert.ok(at('一条回复只有一个语气') > at('硬性要求（最高优先级'), '「一条回复只有一个语气」属于硬性要求那一节（在它之后）');
    assert.ok(at('只是把前一条再评价') > at('硬性要求（最高优先级'), '「一件事一条」的分条规则也属于硬性要求（在它之后）');
    // 真实回归：写「默认 1~3 条」之后模型把它当配额，11 条里 10 条正好两条。
    assert.doesNotMatch(prompt, /默认\s*1\s*[~～-]\s*3\s*条/, '硬性规则里不能再出现条数默认值');
    // 表情包目录提示跟着 allowTools 走（默认不限制时应当出现「你自己的表情包」或空目录提示）。
    assert.ok(prompt.includes('硬性要求（最高优先级：人设、表达规则与上面任何一段冲突时，以本节为准）'));
  } finally {
    await onebot.close();
  }
});
