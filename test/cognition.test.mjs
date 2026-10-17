/**
 * `cognition.js` 的契约测试。
 *
 * 这一层的输出直接决定两件在真实群里看得到的事：
 *   1. 提示词里的**表情包目录**（名字 + 含义）—— 选错一张图，群里就收到一张莫名其妙的图；
 *   2. 每轮的**热梗段** —— 把「置信：存疑」的猜测摆进去，模型就会把猜测当事实用。
 *
 * 所以这里的重点不是「能不能解析」，而是几条**失败方向**：
 * 半行字宁可丢掉、存疑条目宁可不上、路径绝不进提示词、写坏一个区不影响另一个区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendStickerRow,
  cognitionPathViolations,
  hotCognitionLines,
  parseCognition,
  parseStickerCatalog,
  splitFields,
  stickerCatalogLines,
  stickerRow,
} from '../cognition.js';

const COGNITION = `# 公共认知（语言梗 / 黑话 / 缩写 / 谐音）

## 黑话与缩写
- 典｜讽刺「经典操作」，对离谱但符合预期的行为表示无语｜常单独一条，或「典中典」｜首见 2026-10-12｜置信：确认
- 急了｜对方破防、情绪上头了；带调侃，不是真骂｜别在对方真生气时用｜2026-10-12｜置信：确认

## 谐音与变体
- 绷不住了（变体：蚌埠住了 / 绷不住 / 绷）｜忍不住笑了、情绪崩了｜有人发离谱东西时｜贴吧｜2026-10-12｜置信：确认
- 尊嘟假嘟｜真的假的（撒娇说法）｜对方在卖萌时｜2026-10-01｜置信：存疑
`;

function describeCognition() {
  test('splitFields：全角、半角竖线都认，字段去空白', () => {
    assert.deepEqual(splitFields(' 甲 ｜ 乙 | 丙 '), ['甲', '乙', '丙']);
    assert.deepEqual(splitFields('只有一个'), ['只有一个']);
  });

  test('parseCognition：按节归位，变体拆出来', () => {
    const { entries, warnings } = parseCognition(COGNITION);
    assert.equal(warnings.length, 0);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].section, '黑话与缩写');
    assert.equal(entries[0].writeup, '典');
    assert.equal(entries[0].meaning, '讽刺「经典操作」，对离谱但符合预期的行为表示无语');
    assert.equal(entries[0].date, '2026-10-12');
    assert.equal(entries[0].confidence, '确认');
    const variant = entries.find((entry) => entry.writeup === '绷不住了');
    assert.deepEqual(variant.variants, ['蚌埠住了', '绷不住', '绷']);
    assert.equal(variant.source, '贴吧', '来源要留在条目里，只是不注入热梗段');
    assert.equal(variant.section, '谐音与变体');
  });

  test('parseCognition：日期与置信按内容认，写歪一格也不会把日期当「怎么用」', () => {
    const md = '- 好活｜称赞｜2026-10-12｜置信：确认\n';
    const { entries } = parseCognition(md);
    assert.equal(entries[0].meaning, '称赞');
    assert.equal(entries[0].usage, '');
    assert.equal(entries[0].date, '2026-10-12');
  });

  test('parseCognition：半行字丢掉并记警告（宁可少一条，也不让模型照着编）', () => {
    const { entries, warnings } = parseCognition('- 只有一段\n- 好活｜有含义\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].writeup, '好活');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /少于两段/);
  });

  test('parseCognition：空文件、段落说明、注释都不算条目', () => {
    assert.deepEqual(parseCognition('').entries, []);
    const { entries } = parseCognition('# 标题\n\n这只是说明文字。\n\n<!-- 注释 -->\n');
    assert.deepEqual(entries, []);
  });

  test('hotCognitionLines：只取文件末尾、只取确认过的、超预算就停', () => {
    const { entries } = parseCognition(COGNITION);
    const lines = hotCognitionLines(entries);
    assert.ok(lines.every((line) => !line.includes('尊嘟假嘟')), '置信：存疑不能进热梗段');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^典 —— /);
    // 变体要一起显示：聊天里遇到「蚌埠住了」时，模型得认得出它就是这条。
    assert.match(lines[2], /绷不住了（变体：蚌埠住了 \/ 绷不住 \/ 绷）/);
    // 预算：加一条就超时整条不要，不截半句。
    const tight = hotCognitionLines(entries, { maxChars: lines[0].length + 2 });
    assert.deepEqual(tight, [lines[0]]);
    assert.deepEqual(hotCognitionLines(entries, { limit: 0 }), []);
  });

  test('cognitionPathViolations：认知库里出现文件路径要被点名（§9 的硬规则）', () => {
    const { entries } = parseCognition('- 委屈猫｜一张猫｜.qq-media/8f3c1a.gif 那张图｜随便\n');
    const violations = cognitionPathViolations(entries);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, '.qq-media/8f3c1a.gif');
    assert.equal(cognitionPathViolations(parseCognition(COGNITION).entries).length, 0);
  });
}

const STICKERS = `# 表情包目录

## 已收藏
- 委屈猫｜白猫缩成一团、眼泪汪汪｜委屈、求安慰｜对方凶我 / 我装可怜时｜.qq-stickers/委屈猫.gif｜2026-10-12｜置信：确认
- 笑死｜熊猫头大笑｜笑到不行、没眼看｜有人发离谱东西时｜.qq-stickers/笑死.gif｜2026-10-12｜置信：确认

## 未收藏（先收藏再补含义）
- 蓝色女仆捂脸｜.qq-media/ab12cd.gif｜含义待确认
`;

function describeStickers() {
  test('parseStickerCatalog：收藏区与待办区分开，路径按内容认不按位置认', () => {
    const { collected, pending, warnings } = parseStickerCatalog(STICKERS);
    assert.equal(warnings.length, 0);
    assert.equal(collected.length, 2);
    assert.equal(pending.length, 1);
    assert.equal(collected[0].name, '委屈猫');
    assert.equal(collected[0].meaning, '委屈、求安慰');
    assert.equal(collected[0].scene, '对方凶我 / 我装可怜时');
    assert.equal(collected[0].path, '.qq-stickers/委屈猫.gif');
    assert.equal(collected[0].date, '2026-10-12');
    assert.equal(pending[0].name, '蓝色女仆捂脸');
    assert.equal(pending[0].path, '.qq-media/ab12cd.gif');
  });

  test('stickerCatalogLines：提示词里给「名字（含义）」，不是裸文件名', () => {
    const { collected } = parseStickerCatalog(STICKERS);
    assert.deepEqual(stickerCatalogLines(collected), ['委屈猫（委屈、求安慰）', '笑死（笑到不行、没眼看）']);
    assert.deepEqual(stickerCatalogLines(collected, { max: 1 }), ['委屈猫（委屈、求安慰）']);
    assert.deepEqual(stickerCatalogLines([]), []);
  });

  test('parseStickerCatalog：收藏区缺路径或缺含义的条目退回警告，不参与选择', () => {
    const { collected, warnings } = parseStickerCatalog('## 已收藏\n- 只有名字｜白猫\n- 有名字｜画面｜有含义｜场景｜.qq-stickers/有效.gif\n');
    assert.deepEqual(collected.map((entry) => entry.name), ['有名字']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不完整/);
  });

  test('stickerRow / appendStickerRow：追加到对应区，没文件时连标题一起写', () => {
    const entry = { name: '摸摸头', look: '手', meaning: '安慰', scene: '对方难受', path: '.qq-stickers/摸摸头.gif', date: '2026-10-13' };
    assert.equal(stickerRow(entry), '- 摸摸头｜手｜安慰｜对方难受｜.qq-stickers/摸摸头.gif｜2026-10-13｜置信：确认');
    const fresh = appendStickerRow('', entry);
    assert.match(fresh.text, /^# 表情包目录/);
    assert.match(fresh.text, /## 已收藏\n- 摸摸头/);
    assert.equal(fresh.section, '已收藏');
  });

  test('appendStickerRow：插在「已收藏」区最后一条之后，后面的区原样保留', () => {
    const entry = { name: '摸摸头', meaning: '安慰', path: '.qq-stickers/摸摸头.gif' };
    const { text } = appendStickerRow(STICKERS, entry);
    const lines = text.split('\n');
    const cat = lines.findIndex((line) => line.startsWith('- 委屈猫'));
    const added = lines.findIndex((line) => line.startsWith('- 摸摸头'));
    assert.equal(added, cat + 2, '新条目要跟在已收藏区已有条目的后面');
    assert.ok(text.includes('- 蓝色女仆捂脸'), '待办区不能被吞掉');
    assert.ok(lines.indexOf('## 未收藏（先收藏再补含义）') > added);
  });

  test('appendStickerRow：没有区就补一个区，不覆盖原内容', () => {
    const { text } = appendStickerRow('# 表情包目录\n\n随便写的一行\n', { name: 'A', meaning: 'B', path: '.qq-stickers/A.gif' });
    assert.match(text, /随便写的一行/);
    assert.match(text, /## 已收藏\n- A/);
  });

  test('appendStickerRow：没给含义的条目进待办区（写进收藏区等于让模型盲选）', () => {
    const { text, section } = appendStickerRow('', { name: '待确认', path: '.qq-stickers/待确认.gif' }, { collected: false });
    assert.equal(section, '未收藏');
    assert.match(text, /## 未收藏\n- 待确认/);
    assert.doesNotMatch(text.split('## 未收藏')[0], /待确认/);
  });
}

// 两个分组放在最后调用：它们用到的样例常量在文件中间定义（TDZ）。
describeCognition();
describeStickers();
