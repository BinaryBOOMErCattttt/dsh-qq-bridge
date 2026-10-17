/**
 * `persona.js` 的契约测试。
 *
 * 人设写坏的后果不是报错，而是**机器人变成另一个人**（或者没人设）。所以这里钉的重点是
 * 失败方向：
 *   - 不认识的节忽略、不认识的场景忽略、段数不足的条目降级 —— 绝不整份失效；
 *   - 底色最多一条，多出来的降级成点缀并告警；
 *   - 整份没有可用内容时渲染出空数组（调用方据此回退到配置/内置人设）；
 *   - 文件写坏时退回上一次成功的结果（`createPersona`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPersona, parsePersonaDoc, renderPersona } from '../persona.js';

const PERSONA = `# 人设（只写「是谁」；「怎么说」在 STYLE.md）

## 身份
- 名字：小栞
- 自称：我
- 与群的关系：待了半年的群友

## 背景
- 喜欢：深夜的便利店、猫
- 讨厌：被催、被叫「大佬」
- 这些是事实，不是每轮都要念的台词

## 性格
<!-- [x] 启用 / [ ] 停用；一行一条；底色最多一条 -->
- [x] 温柔｜底色｜0.8｜别人倾诉、难受、道歉时｜先接住情绪（「怎么了」「抱抱」），不急着分析、不说教
- [x] 傲娇｜点缀｜0.5｜被夸、被调侃、被戳穿时｜嘴硬一句就结束（「才、才没有」），不补解释、不承认
- [ ] 毒舌｜点缀｜0.3｜熟人互损时｜只吐槽行为，不碰外貌、家人、痛处｜不碰家里人
- [x] 好奇｜点缀｜0.4｜对方提到没见过的东西时｜问一句「那是啥」，不装懂

## 场景
### 私聊
- 更放松一点，可以主动问一句。
### 群聊
- 没人叫你时，插话要接得住上一句。
### 主动搭话
- 只接刚才的话题，不开新话题。
### 被戳一戳
- 先愣一下（「？」）或回戳。
`;

test('parsePersonaDoc：四节各归各位，勾选过滤，场景分开', () => {
  const { profile, warnings } = parsePersonaDoc(PERSONA);
  assert.equal(warnings.length, 0);
  assert.deepEqual(profile.identity[0], { key: '名字', value: '小栞' });
  assert.equal(profile.identity.length, 3);
  assert.equal(profile.background.length, 3);
  // 停用的那条还在数组里，但 enabled=false（渲染时过滤）—— 保留它才能让用户改回来。
  assert.equal(profile.traits.length, 4);
  assert.deepEqual(profile.traits.map((trait) => trait.enabled), [true, true, false, true]);
  assert.equal(profile.traits[0].role, 'base');
  assert.equal(profile.traits[0].strength, 0.8);
  assert.equal(profile.traits[0].trigger, '别人倾诉、难受、道歉时');
  assert.match(profile.traits[1].expression, /嘴硬一句就结束/);
  assert.equal(profile.traits[2].taboo, '不碰家里人');
  assert.deepEqual(profile.scenes.private, ['更放松一点，可以主动问一句。']);
  assert.deepEqual(profile.scenes.poke, ['先愣一下（「？」）或回戳。']);
});

test('parsePersonaDoc：没有勾选框的条目视为启用（兼容手写习惯）', () => {
  const { profile } = parsePersonaDoc('## 性格\n- 直球｜点缀｜0.6｜被问在不在意时｜直接说\n');
  assert.equal(profile.traits[0].enabled, true);
  assert.equal(profile.traits[0].role, 'accent');
});

test('parsePersonaDoc：段数不足降级成「名字 + 描述」，不报错', () => {
  const { profile, warnings } = parsePersonaDoc('## 性格\n- 元气｜话很多很热闹\n');
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    { role: profile.traits[0].role, strength: profile.traits[0].strength, expression: profile.traits[0].expression },
    { role: 'accent', strength: 0.5, expression: '话很多很热闹' },
  );
});

test('parsePersonaDoc：底色最多一条，多出来的降级成点缀并告警', () => {
  const { profile, warnings } = parsePersonaDoc('## 性格\n- 温柔｜底色｜0.8｜倾诉时｜接住情绪\n- 高冷｜底色｜0.6｜默认时｜话少\n');
  assert.equal(profile.traits[0].role, 'base');
  assert.equal(profile.traits[1].role, 'accent');
  assert.ok(warnings.some((line) => line.includes('底色最多一条')));
});

test('parsePersonaDoc：不认识的节 / 场景忽略并告警，不把后面的内容吞掉', () => {
  const { profile, warnings } = parsePersonaDoc('## 口头禅\n- 啊这\n## 身份\n- 名字：小栞\n## 场景\n### 打电话\n- 不该出现\n### 群聊\n- 保留\n');
  assert.equal(profile.identity.length, 1);
  assert.deepEqual(profile.scenes.group, ['保留']);
  assert.equal(warnings.length, 2);
});

test('parsePersonaDoc：空文件 / 只有标题时没有任何内容', () => {
  const { profile } = parsePersonaDoc('# 人设\n\n## 身份\n');
  assert.deepEqual(profile.traits, []);
  assert.deepEqual(profile.identity, []);
});

test('renderPersona：底色在场上、点缀按触发条件、场景按 scene 选，均不逐条表演', () => {
  const { profile } = parsePersonaDoc(PERSONA);
  const lines = renderPersona(profile, { scene: 'group' });
  const text = lines.join('\n');
  assert.match(text, /【身份】名字：小栞；自称：我/);
  assert.match(text, /【背景】喜欢：深夜的便利店、猫/);
  assert.match(text, /【底色｜始终在场】别人倾诉、难受、道歉时 → 温柔：/);
  assert.match(text, /【此刻可能上场｜一次最多演一个】/);
  assert.match(text, /被夸、被调侃、被戳穿时 → 傲娇：/);
  assert.doesNotMatch(text, /毒舌/, '停用的条目不能上场');
  assert.match(text, /【场景｜群聊】没人叫你时，插话要接得住上一句/);
  assert.match(text, /冲突时：底色优先/);
  // 私聊选私聊那段。
  assert.match(renderPersona(profile, { scene: 'private' }).join('\n'), /【场景｜私聊】/);
});

test('renderPersona：sceneOverlays 关掉时不注入任何场景段（排查用）', () => {
  const { profile } = parsePersonaDoc(PERSONA);
  const text = renderPersona(profile, { scene: 'group', overlays: false }).join('\n');
  assert.doesNotMatch(text, /【场景｜/);
});

test('renderPersona：整份为空时返回空数组（调用方据此回退）', () => {
  assert.deepEqual(renderPersona(parsePersonaDoc('').profile), []);
  assert.deepEqual(renderPersona(undefined), []);
});

test('createPersona：文件不存在时返回 undefined；写坏时退回上一次成功的人设', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-persona-'));
  const warnings = [];
  const persona = createPersona({ cwd, file: '.qq-persona/PERSONA.md', report: (level, message) => warnings.push(message) });
  assert.equal(persona.read(), undefined, '没有文件 → undefined，交给配置/内置人设');

  await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), PERSONA, 'utf8').catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cwd, '.qq-persona'), { recursive: true });
    await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), PERSONA, 'utf8');
  });
  const first = persona.read();
  assert.ok(first.profile.traits.length > 0);

  // 被写成半截（只剩标题）：解析出空 profile，必须退回上一版而不是「没人设」。
  await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), '# 人设\n', 'utf8');
  const second = persona.read();
  assert.ok(second !== undefined);
  assert.equal(second.profile.traits.length, first.profile.traits.length);
  assert.ok(warnings.some((line) => line.includes('没有可用的内容')));
});
