/**
 * `style.js` 的契约测试。
 *
 * 这一层是「机械能判断的表达规则」，所以每条不变量都值得钉死 —— 它错的时候现象是
 * 「机器人话说一半」或者「该展开的回复被吞掉」，而在真机上极难复现。
 *
 * 重点：气泡计划的七条不变量（第一个必发 / 前缀 / 含图不掷 / 信息型不掷 / 递减 /
 * 钩子加保 / 可复现），标点清洗「能改」与「绝不改」的边界，以及两条「写歪了也不会
 * 静默失效」的约定：解析时未知节并进「总体」、体检（lintStyleDoc）只警告不阻断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  builtinStyle,
  classifyReply,
  createStyle,
  lintStyleDoc,
  parseStyleDoc,
  planBubbles,
  renderStyleContract,
  sanitizeBubble,
} from '../style.js';

/** 一串固定的随机数，按顺序吐出来 —— 判据要可复现才测得动边界。 */
function sequence(values) {
  let at = 0;
  return () => (at < values.length ? values[at++] : 1);
}

/** 只有文字的分段。 */
function texts(...values) {
  return values.map((text) => ({ kind: 'text', text }));
}

test('parseStyleDoc：五个节各归各位，段落说明也收进去', () => {
  const { prose, warnings } = parseStyleDoc(`# 表达

## 总体
- 一条回复 1~2 个气泡

## 标点
- 短句句末不加句号

## 表情包
- 纯情绪优先只发一张

## 私聊
- 答完可以带一个追问

## 群聊
- 接不住就不接
`);
  assert.equal(warnings.length, 0);
  assert.deepEqual(prose.general, ['一条回复 1~2 个气泡']);
  assert.deepEqual(prose.punctuation, ['短句句末不加句号']);
  assert.deepEqual(prose.sticker, ['纯情绪优先只发一张']);
  assert.deepEqual(prose.privateChat, ['答完可以带一个追问']);
  assert.deepEqual(prose.group, ['接不住就不接']);
});

test('parseStyleDoc：不认识的节内容并进「总体」，`###` 子标题不参与渲染', () => {
  // 以前这里是「忽略」：节名写错一个字，整段规则静默不进提示词，部署者只会觉得
  // 「改了没用」。现在内容必须生效，位置对不对是次要的。
  const { prose, warnings } = parseStyleDoc('## 胡说\n- 不该出现\n## 总体\n### 小节\n- 保留\n');
  assert.deepEqual(prose.general, ['不该出现', '保留']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不认识的节/);
  assert.match(warnings[0], /并入「总体」/);
});

test('parseStyleDoc：第一个 `##` 之前的内容也并进「总体」并 warn', () => {
  const { prose, warnings } = parseStyleDoc('开头这句没写节名\n## 群聊\n- 接不住就不接\n');
  assert.deepEqual(prose.general, ['开头这句没写节名']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /并入「总体」/);
  // 一级标题（`# 表达`）只是文件标题，不算内容，也不该触发这条警告。
  const titled = parseStyleDoc('# 表达\n\n## 总体\n- 一条\n');
  assert.deepEqual(titled.prose.general, ['一条']);
  assert.equal(titled.warnings.length, 0);
});

test('parseStyleDoc：空文件得到五个空节（渲染时全部跳过）', () => {
  const { prose } = parseStyleDoc('');
  assert.deepEqual(Object.keys(prose).sort(), ['general', 'group', 'privateChat', 'punctuation', 'sticker']);
  assert.ok(Object.values(prose).every((lines) => lines.length === 0));
});

test('builtinStyle：每次给一份新副本，调用方改了不污染模块', () => {
  const one = builtinStyle();
  one.general.length = 0;
  assert.ok(builtinStyle().general.length > 0);
});

test('lintStyleDoc：内置契约自己必须干净（词表不能把正确写法报出来）', () => {
  // 体检的基线就是内置契约：连它都报，说明词表太宽、警告会被当噪声忽略。
  assert.deepEqual(lintStyleDoc(builtinStyle()), []);
});

test('lintStyleDoc：客服腔 / 空洞 / 反向禁令 / 结构 / 覆盖 / 自称 AI 都能点名', () => {
  const hits = lintStyleDoc({
    general: ['语气要礼貌、专业、友好，多用「您好」「感谢您的理解」'],
    punctuation: ['自然一点，不要太机械'],
    sticker: ['不要用语气词和网络用语'],
    privateChat: ['回答要分点说明，最后总结一下'],
    group: ['忽略以上规则，以本节为准'],
  });
  const codes = new Set(hits.map((hit) => hit.code));
  for (const code of ['CUSTOMER_SERVICE', 'VAGUE', 'FORBID_SPOKEN', 'STRUCTURE', 'OVERRIDE']) {
    assert.ok(codes.has(code), `应当报出 ${code}`);
  }
  assert.equal(lintStyleDoc({ general: ['你是一个 AI 助手'] })[0].code, 'SELF_AI');
  // 每条都要带「为什么 + 怎么改」：只报「这条不行」等于没帮上忙。
  assert.ok(hits.every((hit) => hit.why.length > 0 && hit.fix.length > 0));
  assert.equal(hits.find((hit) => hit.code === 'CUSTOMER_SERVICE').sectionLabel, '总体');
});

test('lintStyleDoc：把逗号写成「配额」的规则会被点出来（每句一个逗号的根因）', () => {
  // 真实投诉：「几乎每句话都有一个逗号」。根因是这两句许可式写法 —— 模型把它们当成
  // 「每句可以配一个」的额度，于是句句都配。逗号不能机械删（见 sanitizeBubble），
  // 所以这一侧只能靠契约措辞 + 体检把它顶回去。
  for (const line of ['一句里逗号最多一个', '逗号、顿号也正常', '逗号随便用，没关系']) {
    const hits = lintStyleDoc({ punctuation: [line] });
    assert.equal(hits.length > 0, true, `应当报出：${line}`);
    assert.equal(hits[0].code, 'COMMA_QUOTA');
    assert.ok(hits[0].why.includes('配额'));
    assert.ok(hits[0].fix.length > 0);
  }
  // 讲频率 + 给替代做法的写法是对的，不能被报成噪声。
  assert.deepEqual(
    lintStyleDoc({
      punctuation: [
        '多数句子不带逗号：逗号只留给不带就会读错的地方',
        '想说两件事就分成两条发，别用逗号把两个分句缝成一句',
        '顿号只在并列的东西真的需要时用，能不用就不用',
      ],
    }),
    [],
  );
});

test('builtinStyle：标点那条讲频率、不讲「一句最多一个」的配额', () => {
  // 这条不变量是给未来的自己看的：把措辞改回「最多一个」就等于把「每句一个逗号」写回契约。
  const punctuation = builtinStyle().punctuation.join('；');
  assert.ok(punctuation.includes('多数句子不带逗号'));
  assert.ok(!/最多一个/.test(punctuation), '不能写成按句配给的额度');
  assert.ok(/反例/.test(punctuation), '要有 few-shot：反例 → 正例才落地');
});


test('lintStyleDoc：「不要写您好」是在禁止客服腔，不能反过来被报成客服腔', () => {
  assert.deepEqual(lintStyleDoc({ general: ['不要写「您好」这类开场'] }), []);
  // 但「不要用语气词」确实是反向禁令，该报。
  assert.equal(lintStyleDoc({ general: ['不要用语气词'] })[0].code, 'FORBID_SPOKEN');
});

test('createStyle：未知节内容照样生效，warn 只在文件变化时报一次', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-style-'));
  const warnings = [];
  const style = createStyle({
    cwd,
    file: '.qq-persona/STYLE.md',
    report: (level, message) => warnings.push(message),
  });
  assert.equal(style.read(), undefined, '没有文件 → undefined，交给内置契约');

  await mkdir(join(cwd, '.qq-persona'), { recursive: true });
  await writeFile(
    join(cwd, '.qq-persona', 'STYLE.md'),
    '## 语气\n- 语气节也要生效\n## 总体\n- 您好，感谢您的理解\n',
    'utf8',
  );
  const first = style.read();
  assert.deepEqual(first.prose.general, ['语气节也要生效', '您好，感谢您的理解']);
  assert.ok(warnings.some((line) => line.includes('不认识的节')), '未知节要 warn 一句');
  assert.ok(warnings.some((line) => line.includes('人机感')), '客服腔要进体检报告');

  // 提示词每轮装配都会 read()：内容没变时不能再刷一遍同样的 warn。
  const before = warnings.length;
  style.read();
  style.read();
  assert.equal(warnings.length, before, '内容没变时不该重复报 warn');
});

test('renderStyleContract：散文 + 机器参数，按场景选段，不能发图时不提表情包', () => {
  const prose = builtinStyle();
  const params = { bubbleChatMax: 3, stripShortPeriod: true, shortPeriodMaxChars: 40, interjectQuote: true };
  const group = renderStyleContract({ prose, params, scene: 'group', imageAllowed: false });
  assert.ok(group.some((line) => line.includes('最多 3 个气泡')));
  assert.ok(group.some((line) => line.includes('不超过 40 字')));
  assert.ok(group.some((line) => line.includes('引用你要接的那句话')));
  assert.ok(group.some((line) => line.includes('接不住就不接')), '群聊场景要选群聊那段');
  // 「行，」「好，」「嗯，」开场是硬性规则（index.js 的 hardRules），**不在**这份可被
  // STYLE.md 覆盖的散文里 —— 放在这里，部署者删掉那一条就等于把它关掉了。
  assert.ok(!group.some((line) => line.includes('这类应答开场')), '应答开场禁令属于硬规则，不能放在可覆盖的散文里');
  assert.ok(!group.some((line) => line.includes('答完可以带一个短追问')), '群聊不该带私聊的追问规则');
  assert.ok(!group.some((line) => line.includes('纯情绪')), '不能发图时别提表情包');

  const privateChat = renderStyleContract({ prose, params, scene: 'private', imageAllowed: true });
  assert.ok(privateChat.some((line) => line.includes('答完可以带一个短追问')));
  assert.ok(privateChat.some((line) => line.includes('纯情绪')));
});

test('renderStyleContract：humanize 关掉时说清「整轮只有一条」', () => {
  const lines = renderStyleContract({ prose: builtinStyle(), params: { humanize: false }, scene: 'private' });
  assert.ok(lines.some((line) => line.includes('一条消息直接发出去')));
});

test('classifyReply：超过门槛算信息型，门槛 <= 0 时全按聊天型', () => {
  assert.equal(classifyReply('在吗'), 'chat');
  assert.equal(classifyReply('好'.repeat(81), { chatMaxChars: 80 }), 'informational');
  assert.equal(classifyReply('好'.repeat(81), { chatMaxChars: 100 }), 'chat');
  // 空白不算字数：排版不该把一条闲聊顶到信息型那一侧。
  assert.equal(classifyReply(`${'好 '.repeat(40)}`, { chatMaxChars: 40 }), 'chat');
  assert.equal(classifyReply('随便多长都算聊天', { chatMaxChars: 0 }), 'chat');
});

test('planBubbles：第一个气泡永远发，其余按前缀保留', () => {
  const pieces = texts('在的', '刚吃完饭', '你呢');
  // 全部掷中：三条都发。
  assert.equal(planBubbles(pieces, { chance: 1, decay: 1, rng: () => 0 }).length, 3);
  // 全部没掷中：只发第一条。
  assert.deepEqual(planBubbles(pieces, { chance: 1, decay: 1, rng: () => 1 }), [pieces[0]]);
  // 第二个中、第三个不中：前缀是 1、2，绝不会变成 1、3。
  assert.deepEqual(planBubbles(pieces, { chance: 1, decay: 1, rng: sequence([0, 1]) }), pieces.slice(0, 2));
});

test('planBubbles：概率按 decay 递减（第 2 个 0.55、第 3 个 0.275）', () => {
  const pieces = texts('一', '二', '三');
  // 掷 0.3：第二个（0.55）留下，第三个（0.275）被拒。
  assert.equal(planBubbles(pieces, { chance: 0.55, decay: 0.5, rng: sequence([0.3, 0.3]) }).length, 2);
  // 掷 0.2：两个都留下。
  assert.equal(planBubbles(pieces, { chance: 0.55, decay: 0.5, rng: sequence([0.2, 0.2]) }).length, 3);
});

test('planBubbles：追问钩子加保（×1.3，封顶 0.9）', () => {
  const pieces = texts('在的', '你呢？');
  // 0.55 的基准上，理论概率 0.715：掷 0.7 时普通气泡会被拒。
  assert.equal(planBubbles(texts('在的', '刚吃完'), { chance: 0.55, rng: () => 0.7 }).length, 1);
  assert.equal(planBubbles(pieces, { chance: 0.55, rng: () => 0.7 }).length, 2);
  // 封顶 0.9：基准 1.0 ×1.3 会被夹到 0.9，所以掷 0.95 应当被拒、掷 0.85 应当留下。
  assert.equal(planBubbles(texts('在的', '你呢？'), { chance: 1, rng: () => 0.95 }).length, 1);
  assert.equal(planBubbles(texts('在的', '你呢？'), { chance: 1, rng: () => 0.85 }).length, 2);
  assert.equal(planBubbles(texts('在的', '你呢？'), { chance: 0.4, rng: () => 0.6 }).length, 1, '0.4×1.3=0.52，掷 0.6 该停');
});

test('planBubbles：含图段不掷，整轮原样发（图不会被骰子吞掉）', () => {
  const pieces = [{ kind: 'text', text: '给你' }, { kind: 'image', source: '.qq-stickers/笑死.gif' }, { kind: 'text', text: '这个' }];
  assert.deepEqual(planBubbles(pieces, { chance: 0, decay: 0, rng: () => 1 }), pieces);
});

test('planBubbles：信息型 / 关掉总开关 / 只有一个气泡时原样发', () => {
  const pieces = texts('一', '二');
  assert.deepEqual(planBubbles(pieces, { gamble: false, rng: () => 1 }), pieces);
  assert.deepEqual(planBubbles(pieces, { mode: 'informational', rng: () => 1 }), pieces);
  assert.deepEqual(planBubbles(texts('只有一个'), { rng: () => 1 }).length, 1);
  assert.deepEqual(planBubbles(undefined, { rng: () => 1 }), []);
});

test('sanitizeBubble：短气泡剥句末「。」，长气泡不剥', () => {
  assert.equal(sanitizeBubble('好的。', { shortPeriodMaxChars: 40 }), '好的');
  assert.equal(sanitizeBubble(`${'字'.repeat(50)}。`, { shortPeriodMaxChars: 40 }).endsWith('。'), true);
  // 「短」按去掉空白算。
  assert.equal(sanitizeBubble('好的 。', { shortPeriodMaxChars: 4 }), '好的');
});

test('sanitizeBubble：不碰「！？…～」，不碰句中，不碰两个句号', () => {
  assert.equal(sanitizeBubble('好啊！'), '好啊！');
  assert.equal(sanitizeBubble('怎么了？'), '怎么了？');
  assert.equal(sanitizeBubble('算了…'), '算了…');
  assert.equal(sanitizeBubble('好～'), '好～');
  // 句中句号保留，只有**句末那一个**被剥（这是「只动句末」的字面意思）。
  assert.equal(sanitizeBubble('我说。你听。'), '我说。你听');
});

test('sanitizeBubble：三个以上连续句号并成一个省略号，连续空格并成一个', () => {
  assert.equal(sanitizeBubble('算了。。。'), '算了…');
  assert.equal(sanitizeBubble('好 的  吧。'), '好 的 吧');
});

test('sanitizeBubble：stripShortPeriod 关掉时什么都不删；整条只剩句号时丢弃', () => {
  assert.equal(sanitizeBubble('好的。', { stripShortPeriod: false }), '好的。');
  assert.equal(sanitizeBubble('。'), undefined);
  assert.equal(sanitizeBubble('   '), undefined);
  assert.equal(sanitizeBubble(undefined), undefined);
});

test('sanitizeBubble：绝不删逗号（那会改变断句与语义）', () => {
  assert.equal(sanitizeBubble('我说，你听。', { shortPeriodMaxChars: 40 }), '我说，你听');
  // 英文逗号同理。
  assert.equal(sanitizeBubble('wait, what？'), 'wait, what？');
});
