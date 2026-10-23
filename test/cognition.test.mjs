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
  cognitionVocabulary,
  duplicateSectionNames,
  hotCognitionLines,
  normalizeCognitionDoc,
  normalizeStickerDoc,
  parseCognition,
  parseStickerCatalog,
  removeCognitionRow,
  removeStickerRow,
  renameStickerRow,
  splitFields,
  stickerCatalogLines,
  stickerRow,
  upsertCognitionRow,
  upsertStickerRow,
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

  test('parseCognition：漏写置信按存疑算；「核实」进 verified，不挤占来源', () => {
    const { entries } = parseCognition([
      '- 没写清楚｜大概是这个意思',
      '- 核过了｜确实如此｜2026-10-12｜置信：确认｜核实 2026-10-23',
    ].join('\n'));
    // 2026-10-23 的存量核验里查出错的那 8 条，全都是漏写置信的那批 —— 缺省必须是
    // 「存疑」（看不见），而不是「确认」（每轮当成事实）。
    assert.equal(entries[0].confidence, '存疑', '漏写置信不能默认成「确认」');
    assert.equal(entries[0].verified, '');
    assert.equal(entries[1].confidence, '确认');
    assert.equal(entries[1].verified, '2026-10-23');
    assert.equal(entries[1].source, '', '「核实」是核对记录，不是来源，不能顶到 source 的位置');
    assert.equal(entries[1].date, '2026-10-12');
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

  test('hotCognitionLines：没核实过的条目带「未核实」尾巴，核过的没有', () => {
    const { entries } = parseCognition([
      '## 黑话与缩写',
      '- 群里说的｜大概是这个意思｜置信：确认',
      '- 核过的｜确实如此｜置信：确认｜核实 2026-10-23',
      '- 漏写置信的｜连置信都没写',
    ].join('\n'));
    const lines = hotCognitionLines(entries, { limit: 9 });
    assert.deepEqual(lines, [
      '群里说的 —— 大概是这个意思（群里的说法，未核实）',
      '核过的 —— 确实如此',
    ], '只有「确认但没核实」的才带尾巴；漏写置信的根本不进热梗段');
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

  test('stickerCatalogLines：提示词里给「名字（含义）→ 完整路径」，扩展名不用模型猜', () => {
    const { collected } = parseStickerCatalog(STICKERS);
    assert.deepEqual(stickerCatalogLines(collected), [
      '委屈猫（委屈、求安慰） → .qq-stickers/委屈猫.gif',
      '笑死（笑到不行、没眼看） → .qq-stickers/笑死.gif',
    ]);
    assert.deepEqual(stickerCatalogLines(collected, { max: 1 }), ['委屈猫（委屈、求安慰） → .qq-stickers/委屈猫.gif']);
    assert.deepEqual(stickerCatalogLines([]), []);
    // 没有路径的老条目不会拼出 `→ undefined`。
    assert.deepEqual(stickerCatalogLines([{ name: '旧条目', meaning: '含义', path: '' }]), ['旧条目（含义）']);
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

/** 逐条写入、写入归一化、注入顺序 —— 这三组对应「模型别再整份重写 markdown」。 */
function describeStructuredWrites() {
  test('hotCognitionLines：注入「最近」按首见日期算，不按文件里的位置', () => {
    const a = parseCognition(['## 黑话与缩写', '- 旧梗｜很早学的｜2026-09-01｜置信：确认｜核实 2026-09-01', '- 新梗｜刚学的｜2026-10-17｜置信：确认｜核实 2026-10-17'].join('\n')).entries;
    const b = parseCognition(['## 黑话与缩写', '- 新梗｜刚学的｜2026-10-17｜置信：确认｜核实 2026-10-17', '- 旧梗｜很早学的｜2026-09-01｜置信：确认｜核实 2026-09-01'].join('\n')).entries;
    assert.deepEqual(hotCognitionLines(a, { limit: 1 }), ['新梗 —— 刚学的']);
    assert.deepEqual(hotCognitionLines(b, { limit: 1 }), ['新梗 —— 刚学的'], '换个排列不该换成另一条');
  });

  test('hotCognitionLines：无日期条目按文件位置参与排序，不再一律当最旧（设计 §1.2 的回归）', () => {
    // 一条老梗写在文件中间、没有日期；后面还有两条有日期的新梗。旧实现把它当最旧，
    // 于是 15 条上限一满它就永远进不了提示词。
    const entries = parseCognition([
      '## 黑话与缩写',
      '- 老说法｜很久以前学的，没写日期｜置信：确认｜核实 2026-10-01',
      '- 新梗｜刚学的｜2026-10-17｜置信：确认｜核实 2026-10-17',
      '- 更新梗｜更近学的｜2026-10-18｜置信：确认｜核实 2026-10-18',
    ].join('\n')).entries;
    // 只留最近两条：老说法紧跟在新梗之前（位置），应当挤掉它、留下两条有日期的，
    // 而不是被当成「最旧」直接出局。
    assert.deepEqual(hotCognitionLines(entries, { limit: 2 }), ['新梗 —— 刚学的', '更新梗 —— 更近学的']);
    // 换个位置：没有日期的条目写在**最新**的那条后面 → 继承它的日期并排在它之后，
    // 于是能进前两条（这正是「写在文件后半段的老条目不再被静默丢掉」）。
    const tail = parseCognition([
      '## 黑话与缩写',
      '- 新梗｜刚学的｜2026-10-17｜置信：确认｜核实 2026-10-17',
      '- 更新梗｜更近学的｜2026-10-18｜置信：确认｜核实 2026-10-18',
      '- 老说法｜很久以前学的，没写日期｜置信：确认｜核实 2026-10-01',
    ].join('\n')).entries;
    const picked = hotCognitionLines(tail, { limit: 2 });
    assert.ok(picked.some((line) => line.startsWith('老说法')), `无日期条目应当能进热梗段，实际：${picked.join(' | ')}`);
  });

  test('cognitionVocabulary：全部梗的写法（含变体）按文件顺序去重', () => {
    const { entries } = parseCognition(COGNITION);
    assert.deepEqual(cognitionVocabulary(entries), [
      '典',
      '急了',
      '绷不住了',
      '蚌埠住了',
      '绷不住',
      '绷',
      '尊嘟假嘟',
    ]);
    assert.deepEqual(cognitionVocabulary([]), []);
  });

  test('upsertCognitionRow：同写法原地替换，别的条目一字不动', () => {
    const before = '## 黑话与缩写\n- 典｜旧意思\n- 急了｜破防\n';
    const { text, replaced, section } = upsertCognitionRow(before, { writeup: '典', meaning: '讽刺「经典操作」', usage: '有人发离谱东西时' });
    assert.equal(replaced, true);
    assert.equal(section, '黑话与缩写');
    assert.match(text, /- 典｜讽刺「经典操作」｜有人发离谱东西时｜置信：确认/);
    assert.match(text, /- 急了｜破防/, '其它条目必须原样保留');
    // 名字包了反引号也认得住（模型常这么写）。
    assert.equal(upsertCognitionRow(before, { writeup: '`典`', meaning: 'x' }).replaced, true);
  });

  test('upsertCognitionRow：新条目按 type 归节，没有那个节就补一个', () => {
    const { text, section } = upsertCognitionRow('## 黑话与缩写\n- 典｜经典操作\n', { writeup: '蚌埠住了', meaning: '绷不住了', type: '谐音', variants: '绷不住/绷' });
    assert.equal(section, '谐音与变体');
    assert.match(text, /## 谐音与变体\n- 蚌埠住了（变体：绷不住 \/ 绷）｜绷不住了｜置信：确认/);
    // 没有含义直接拒绝：解析器会把这种行整个丢掉，不能「写成功」。
    assert.throws(() => upsertCognitionRow('', { writeup: '空' }), /meaning/);
  });

  test('removeCognitionRow / removeStickerRow：只删那一条', () => {
    const cog = removeCognitionRow('## 黑话与缩写\n- 典｜a\n- 急｜b\n', '典');
    assert.equal(cog.removed, true);
    assert.doesNotMatch(cog.text, /典/);
    assert.match(cog.text, /急｜b/);
    assert.equal(removeCognitionRow(cog.text, '不存在').removed, false);

    const st = upsertStickerRow('# 表情包目录\n\n## 已收藏\n', { name: '疑惑', meaning: '没听懂', path: '.qq-stickers/疑惑.jpg' });
    const gone = removeStickerRow(st.text, '疑惑');
    assert.equal(gone.removed, true);
    assert.doesNotMatch(gone.text, /疑惑/);
  });

  test('upsertStickerRow：同名替换而不是再追加一条（未收藏补了含义会升进已收藏）', () => {
    const pending = '# 表情包目录\n\n## 已收藏\n\n## 未收藏\n- 疑惑｜.qq-stickers/疑惑.jpg｜待补含义\n';
    const { text, replaced, section } = upsertStickerRow(pending, { name: '疑惑', meaning: '没听懂、满脸问号', path: '.qq-stickers/疑惑.jpg' });
    assert.equal(replaced, true);
    assert.equal(section, '已收藏');
    assert.equal(parseStickerCatalog(text).collected.length, 1);
    assert.equal(parseStickerCatalog(text).pending.length, 0, '旧的待办行必须被替换掉，不能两份并存');
    const again = upsertStickerRow(text, { name: '疑惑', meaning: '没听懂', path: '.qq-stickers/疑惑.jpg' });
    assert.equal(parseStickerCatalog(again.text).collected.length, 1);
  });

  test('renameStickerRow：按旧名字搬整行，旧名不留下、字段不丢', () => {
    const { text, renamed, section } = renameStickerRow(STICKERS, '委屈猫', {
      name: '委屈',
      path: '.qq-stickers/委屈.gif',
    });
    assert.equal(renamed, true);
    assert.equal(section, '已收藏');
    const parsed = parseStickerCatalog(text);
    assert.deepEqual(parsed.collected.map((entry) => entry.name), ['委屈', '笑死']);
    assert.equal(parsed.collected[0].meaning, '委屈、求安慰', '改名字不能把含义丢了');
    assert.equal(parsed.collected[0].scene, '对方凶我 / 我装可怜时');
    assert.equal(parsed.collected[0].look, '白猫缩成一团、眼泪汪汪');
    assert.equal(parsed.collected[0].path, '.qq-stickers/委屈.gif');
    assert.equal(parsed.collected[0].date, '2026-10-12', '首见日期跟着走，不要重置成今天');
    assert.doesNotMatch(text, /委屈猫/, '旧名字那条必须消失，否则以后两张都会被挑中');
    assert.match(text, /- 蓝色女仆捂脸/, '未收藏区原样保留');
  });

  test('renameStickerRow：顺手给新含义 / 场景 / 画面时以新值为准（pending 会升进已收藏）', () => {
    const { text, section } = renameStickerRow(STICKERS, '蓝女仆', {
      name: '女仆捂脸',
      path: '.qq-stickers/女仆捂脸.gif',
      look: '蓝发女仆捂着嘴',
      meaning: '害羞、没眼看',
      scene: '被人夸的时候',
    });
    // 旧名字不在（内容里只有更长的「蓝色女仆捂脸」）→ renamed: false 只追加一条新的。
    assert.equal(section, '已收藏');
    assert.equal(parseStickerCatalog(text).collected.length, 3);

    const pending = '# 表情包目录\n\n## 已收藏\n\n## 未收藏\n- 疑惑｜.qq-stickers/疑惑.jpg｜待补含义\n';
    const up = renameStickerRow(pending, '疑惑', { name: '满脸问号', path: '.qq-stickers/满脸问号.jpg', meaning: '没听懂' });
    assert.equal(up.renamed, true);
    assert.equal(up.section, '已收藏', '改名时补了含义，就该升进已收藏');
    const parsed = parseStickerCatalog(up.text);
    assert.deepEqual(parsed.collected.map((entry) => entry.name), ['满脸问号']);
    assert.equal(parsed.pending.length, 0);
    assert.equal(parsed.collected[0].meaning, '没听懂');
    assert.doesNotMatch(up.text, /疑惑/);
  });

  test('renameStickerRow：旧名字认不出来时只追加一条新的（renamed=false），名字照样要求非空', () => {
    const { text, renamed } = renameStickerRow(STICKERS, '不存在', { name: '新表情', meaning: '随便', path: '.qq-stickers/新表情.gif' });
    assert.equal(renamed, false);
    assert.equal(parseStickerCatalog(text).collected.length, 3);
    assert.throws(() => renameStickerRow(STICKERS, '委屈猫', { name: '  ', path: '.qq-stickers/x.gif' }), /new sticker name/);
    assert.throws(() => renameStickerRow(STICKERS, '', { name: 'x', path: '.qq-stickers/x.gif' }), /current sticker name/);
  });

  test('normalizeCognitionDoc：合并重复标题、去掉完全相同的行，但不吃同写法不同义的条目', () => {
    const dup = [
      '# 公共认知',
      '',
      '## 黑话与缩写',
      '- 典｜a',
      '',
      '## 黑话与缩写',
      '- 典｜a',
      '- 南梁｜群 A 里指男娘',
      '- 南梁｜群 B 里指别的东西',
      '',
    ].join('\n');
    const text = normalizeCognitionDoc(dup);
    assert.equal(duplicateSectionNames(text).length, 0, '重复标题必须合掉');
    assert.equal(parseCognition(text).entries.length, 3, '完全相同的行只留一条，不同义的两条都要在');
    assert.equal(normalizeCognitionDoc(text), text, '幂等');
  });

  test('normalizeStickerDoc：同名条目只留最后一条，不同名的不动', () => {
    const same = normalizeStickerDoc('# X\n\n## 已收藏\n- 无语｜画面｜旧｜.qq-stickers/a.gif\n- 无语｜画面｜新｜.qq-stickers/b.gif\n');
    const parsedSame = parseStickerCatalog(same);
    assert.equal(parsedSame.collected.length, 1);
    assert.match(same, /b\.gif/, '保留最后写的那条');
    const different = normalizeStickerDoc('# X\n\n## 已收藏\n- 无语｜画面｜a｜.qq-stickers/a.gif\n- 疑惑｜画面｜b｜.qq-stickers/c.gif\n');
    assert.equal(parseStickerCatalog(different).collected.length, 2);
  });

  test('duplicateSectionNames：重复标题点名，正常文件为空', () => {
    assert.deepEqual(duplicateSectionNames('## A\n- x\n## A\n'), ['A']);
    assert.deepEqual(duplicateSectionNames('## A\n- x\n## B\n- y\n'), []);
  });
}

// 三个分组放在最后调用：它们用到的样例常量在文件中间定义（TDZ）。
describeCognition();
describeStickers();
describeStructuredWrites();
