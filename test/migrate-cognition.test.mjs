/**
 * `scripts/migrate-cognition.mjs` 的契约测试。
 *
 * 迁移动的是**人的记忆文件**，所以这里的重点全是「别把它搞坏」：
 *   - 默认 dry-run，`--apply` 才写；
 *   - 写之前一定留下备份；
 *   - 认不出的图**不删**，只降级成「未收藏 + 原图已过期」；
 *   - 同一张表情包被 QQ 重新编码过也要认得出（画面指纹，不是字节哈希）；
 *   - 已经迁过的文件再跑一遍，什么都不改（幂等）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyCognitionMigration, planCognitionMigration } from '../scripts/migrate-cognition.mjs';
import { PIC_JPEG, PIC_JPEG_RECODE } from './image-fixtures.mjs';

/** 造一个成品：`.qq-memory/COGNITION.md` + 可选的表情包文件。 */
async function workspace({ cognition, memory = 'COGNITION.md', stickers = {}, media = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-migrate-'));
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });
  await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
  await mkdir(join(cwd, '.qq-media'), { recursive: true });
  if (cognition !== undefined) await writeFile(join(cwd, '.qq-memory', memory), cognition, 'utf8');
  for (const [name, bytes] of Object.entries(stickers)) await writeFile(join(cwd, '.qq-stickers', name), bytes);
  for (const [name, bytes] of Object.entries(media)) await writeFile(join(cwd, '.qq-media', name), bytes);
  return cwd;
}

test('路径作键的老条目：认出收藏图就迁过去，认知库里整条不剩空壳', async () => {
  // 同一张图：`.qq-media` 里是原始字节，`.qq-stickers` 里是用户存过的另一份（字节不同）。
  const cwd = await workspace({
    cognition: '# 公共认知\n\n## 表情包\n- .qq-media/aaaabbbb.jpg｜一张猫摇头｜表示「不不不」｜拒绝时｜2026-10-12｜置信：确认\n',
    stickers: { '摇头.jpg': PIC_JPEG },
    media: { 'aaaabbbb.jpg': PIC_JPEG_RECODE },
  });
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.moved, 1);
  assert.equal(plan.entries[0].sticker, '.qq-stickers/摇头.jpg');
  // 认知库只剩标题（那条本来整条都是图的意思）。
  assert.doesNotMatch(plan.next.cognition, /qq-media/);
  assert.match(plan.next.cognition, /## 表情包/);
  // 目录里是「已收藏」，键是收藏后的文件名。
  assert.match(plan.next.stickers, /## 已收藏\n- 摇头｜一张猫摇头｜表示「不不不」｜拒绝时｜\.qq-stickers\/摇头\.jpg/);
});

test('路径被反引号包着也要认出来（本机真实事故：包了反引号 → 搬走 0 → STICKERS.md 一直没生成）', async () => {
  const cwd = await workspace({
    // 摘要 Agent / 旧提示词习惯把路径包一层反引号，这一行就是这么写进 COGNITION.md 的。
    cognition: '# 公共认知\n\n## 表情包\n- `.qq-media/aaaabbbb.jpg`｜一张猫摇头｜表示「不不不」｜拒绝时｜2026-10-12\n',
    stickers: { '摇头.jpg': PIC_JPEG },
    media: { 'aaaabbbb.jpg': PIC_JPEG },
  });
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.moved, 1);
  assert.doesNotMatch(plan.next.cognition, /qq-media/);
  assert.match(plan.next.stickers, /- 摇头｜一张猫摇头｜表示「不不不」｜拒绝时｜\.qq-stickers\/摇头\.jpg/);
});

test('识别靠画面指纹：QQ 重新编码过的同一张图也能认出来', async () => {
  const cwd = await workspace({
    cognition: '## 表情包\n- .qq-media/ccccdddd.jpg｜熊猫头大笑｜笑到不行｜有人发离谱东西时\n',
    stickers: { '笑死.jpg': PIC_JPEG },
    // `PIC_JPEG_RECODE` 是同一张画面重新编码的字节（与 PIC_JPEG 字节不同、画面一致）。
    media: { 'ccccdddd.jpg': PIC_JPEG_RECODE },
  });
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.moved, 1, '画面指纹相近时应当认成同一张');
  assert.match(plan.next.stickers, /\.qq-stickers\/笑死\.jpg/);
});

test('认不出的图不删：降级成「未收藏 + 原图已过期」，需要人看一眼', async () => {
  const cwd = await workspace({
    cognition: '## 表情包\n- .qq-media/deadbeef.gif｜蓝色女仆捂脸｜没眼看\n',
    stickers: { '笑死.jpg': PIC_JPEG },
  });
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.moved, 0);
  assert.equal(plan.stats.needsHuman, 1);
  assert.match(plan.next.stickers, /## 未收藏/);
  assert.match(plan.next.stickers, /原图已过期/);
  // `.qq-media` 路径没有被当成收藏路径写进目录（那条硬规则）。
  assert.match(plan.next.stickers, /- 蓝色女仆捂脸｜.*\.qq-media\/deadbeef\.gif/);
  assert.equal(plan.entries[0].action, 'needs-human');
});

test('写法在前、路径混在中间：图迁走，那个词仍留在认知库（去掉路径）', async () => {
  const cwd = await workspace({
    cognition: '## 表情包\n- 摇头猫｜一张猫摇头｜.qq-stickers/摇头.jpg｜表示不不不｜2026-10-12\n',
    stickers: { '摇头.jpg': PIC_JPEG },
  });
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.moved, 1);
  assert.match(plan.next.cognition, /- 摇头猫｜一张猫摇头｜表示不不不｜2026-10-12/);
  assert.doesNotMatch(plan.next.cognition, /\.qq-stickers/);
});

test('解析器跳过的碎条目不能被挤掉：只替换「认出来的那几行」，其余原样留在原处', async () => {
  // 真实文件里就有这种手写碎条目（少于两段 → parseCognition 只记 warn、不当条目）。
  // 老实现按「第几个 - 行」回填，它后面的条目会整体错位，末尾几条被吃掉。
  const cognition = [
    '# 公共认知',
    '',
    '## 黑话与缩写',
    '- 魔了｜魔怔了',
    '- 只写了一段没有竖线的碎条目',
    '- 中杯｜给角色评强度的说法',
    '',
    '## 表情包',
    '- 菲比｜鸣潮角色',
    '- .qq-media/aaaabbbb.jpg｜猫摇头｜不不不',
    '- jtb｜群友外号',
    '',
  ].join('\n');
  const cwd = await workspace({ cognition });
  const plan = await planCognitionMigration({ cwd });
  const text = plan.next.cognition;
  assert.match(text, /只写了一段没有竖线的碎条目/, '解析器跳过的行必须原样保留');
  // 四条正常条目一条都不能少，顺序也不能变。
  const order = ['魔了', '只写了一段没有竖线的碎条目', '中杯', '菲比', 'jtb'].map((word) => text.indexOf(word));
  assert.ok(order.every((at) => at >= 0), `条目被吃掉了：${text}`);
  for (let index = 1; index < order.length; index += 1) assert.ok(order[index - 1] < order[index], '顺序被打乱了');
  // 迁走的那条（路径作键）才允许从认知库消失。
  assert.doesNotMatch(text, /qq-media/);
  assert.match(plan.next.stickers, /猫摇头/);
});

test('没有 COGNITION.md 时什么都不做，只给一句说明', async () => {
  const cwd = await workspace({});
  const plan = await planCognitionMigration({ cwd });
  assert.equal(plan.stats.total, 0);
  assert.match(plan.note, /没什么可迁的/);
});

test('dry-run 不写盘；--apply 先备份再写，且重复执行幂等', async () => {
  const cognition = '## 表情包\n- .qq-media/aaaabbbb.jpg｜猫｜委屈\n';
  const cwd = await workspace({ cognition, stickers: { '委屈猫.jpg': PIC_JPEG }, media: { 'aaaabbbb.jpg': PIC_JPEG } });
  const plan = await planCognitionMigration({ cwd });
  await assert.rejects(() => readFile(join(cwd, '.qq-memory', 'STICKERS.md'), 'utf8'), 'dry-run 不该写 STICKERS.md');

  const applied = await applyCognitionMigration(plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.backups.length, 1, '原 COGNITION.md 必须先备份');
  assert.ok(existsSync(applied.backups[0]));
  assert.equal(await readFile(applied.backups[0], 'utf8'), cognition, '备份是原文件的逐字节副本');
  assert.match(await readFile(join(cwd, '.qq-memory', 'STICKERS.md'), 'utf8'), /委屈猫/);

  // 再跑一遍：已经没有带路径的条目，统计里不再有 moved。
  const again = await planCognitionMigration({ cwd });
  assert.equal(again.stats.moved, 0);
  assert.equal(again.stats.needsHuman, 0);
  // 备份文件不该被当成图片扫进结果。
  const backups = (await readdir(join(cwd, '.qq-memory'))).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1);
});
