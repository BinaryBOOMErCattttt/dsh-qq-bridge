/**
 * `settings.js` 的契约测试。
 *
 * 这一层是**唯一的**「取默认值 / 强制类型 / 夹紧」的地方，`index.js` 只管读结果，
 * 所以它错了没有任何下游会兜住 —— 每条规则都得在这里钉死。
 *
 * 用例分两类，都重要：
 *   1. 正常值原样通过（别把好配置改坏）；
 *   2. **非法值**（NaN / 负数 / 越界）退到哪 —— 这是重构时最容易搬错、且真宿主上
 *      很难触发的一类分支。
 *
 * 不经过 Harness：`createSettings` 是纯函数，只需要配置对象。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../config.js';
import { createSettings, MAX_TIMER_MS } from '../settings.js';
import { liveConfig } from '../util.js';

/**
 * 用真 schema 铺一层默认值，再按需覆盖 —— 覆盖的可以是 schema 不会产出的非法值。
 *
 * `liveConfig` 是必须的：schema 是根 volatile（Web UI 设置页的前提，见 config.js），
 * `Config({})` 解析出来的是**引用**，直接往 createSettings 里传会读不到任何字段。
 */
function settings(overrides = {}, cwd = '/tmp') {
  return createSettings({ ...liveConfig(Config({})), ...overrides }, cwd);
}

test('默认配置原样落到 settings 上', () => {
  const s = settings();
  assert.equal(s.batchWindowMs, 2000);
  assert.equal(s.batchMaxWaitMs, 5000);
  assert.equal(s.batchBacklog, true);
  assert.equal(s.batchBacklogEntries, 20);
  assert.equal(s.batchBacklogChars, 2000);
  assert.equal(s.batchBacklogHoldMs, 120000);
  assert.equal(s.maxReplyChars, 1500);
  assert.equal(s.activeWindowMs, 60 * 1000);
  assert.equal(s.activeGroupLines, 6);
  assert.equal(s.activeGroupSpeakers, 2);
  assert.equal(s.activeGroupBatchScale, 2);
  assert.equal(s.activeTalkChance, 0.05);
  assert.equal(s.activeTalkChanceStep, 0.1);
  assert.equal(s.activeTalkChanceMax, 0.8);
  assert.equal(s.proactiveIdleMs, 45 * 60 * 1000);
  assert.equal(s.proactiveDailyMax, 4);
  assert.equal(s.digestAtHour, 4);
  assert.equal(s.memorySearchHits, 40);
  assert.equal(s.repeatCount, 2);
});

test('攒批的 0 = 关闭（与「非法值退回默认」不是一回事）', () => {
  assert.equal(settings({ batchWindowMs: 0 }).batchWindowMs, 0);
  assert.equal(settings({ batchWindowMs: -5 }).batchWindowMs, 0);
  // 负数与 NaN 都退到 0（关闭），**不是**退到默认的 2000：把「乱配」当成「关掉」
  // 比当成「每 2 秒回一条」安全。
  assert.equal(settings({ batchWindowMs: NaN }).batchWindowMs, 0);
  assert.equal(settings({ batchMaxWaitMs: NaN }).batchMaxWaitMs, 0);
});

test('积压那一波的条数 / 字数 / 憋多久：非法退回默认，条数下限 2', () => {
  // 条数与字数没有「0 = 关闭」的语义 —— 关掉这一项用 batchBacklog: false。
  // 配 0 / 1 只能理解成「贴得尽量少」，那不是「一条都不贴」：至少留第一条 + 最后一条。
  assert.equal(settings({ batchBacklogEntries: 0 }).batchBacklogEntries, 20);
  assert.equal(settings({ batchBacklogEntries: 1 }).batchBacklogEntries, 2);
  assert.equal(settings({ batchBacklogEntries: 5 }).batchBacklogEntries, 5);
  assert.equal(settings({ batchBacklogEntries: NaN }).batchBacklogEntries, 20);
  assert.equal(settings({ batchBacklogChars: 0 }).batchBacklogChars, 2000);
  assert.equal(settings({ batchBacklogChars: 300 }).batchBacklogChars, 300);
  assert.equal(settings({ batchBacklogChars: NaN }).batchBacklogChars, 2000);
  // 憋多久和别的毫秒项同一口径：非法回默认，负数按 0（= 不憋）。
  assert.equal(settings({ batchBacklogHoldMs: NaN }).batchBacklogHoldMs, 120000);
  assert.equal(settings({ batchBacklogHoldMs: -1 }).batchBacklogHoldMs, 0);
  assert.equal(settings({ batchBacklog: false }).batchBacklog, false);
});

test('活下来的一批毫秒项：非法退回默认，负数按 0', () => {
  // 这几项和攒批不同：默认值是「一个合理的等待」，所以非法时该回到默认而不是关闭。
  assert.equal(settings({ proactiveIdleMs: 'nonsense' }).proactiveIdleMs, 45 * 60 * 1000);
  assert.equal(settings({ proactiveIdleMs: -1 }).proactiveIdleMs, 0);
  assert.equal(settings({ activeWindowMs: -1 }).activeWindowMs, 0);
  assert.equal(settings({ activeWindowMs: 1234.7 }).activeWindowMs, 1234);
  assert.equal(settings({ activeChimeMax: 3 }).activeChimeMax, 3);
});

test('表情包张数上限：0 = 明确的不限制，非法值退回默认的 60', () => {
  // 这是唯一一个「QQ 那头能一直往里塞东西」的上限，所以两个方向都要钉住：
  // 手滑配错（字符串 / 负数 / NaN）绝不能被当成「不限制」。
  assert.equal(settings().stickerMaxFiles, 60);
  assert.equal(settings({ stickerMaxFiles: 0 }).stickerMaxFiles, 0);
  assert.equal(settings({ stickerMaxFiles: 12 }).stickerMaxFiles, 12);
  assert.equal(settings({ stickerMaxFiles: -1 }).stickerMaxFiles, 60);
  assert.equal(settings({ stickerMaxFiles: NaN }).stickerMaxFiles, 60);
  assert.equal(settings({ stickerMaxFiles: 'nonsense' }).stickerMaxFiles, 60);
});

test('有明确上下界的整数项被夹紧', () => {
  assert.equal(settings({ digestAtHour: 25 }).digestAtHour, 23);
  assert.equal(settings({ digestAtHour: -1 }).digestAtHour, 0);
  assert.equal(settings({ digestAtHour: NaN }).digestAtHour, 4);
  assert.equal(settings({ apiKeyRotateHour: 99 }).apiKeyRotateHour, 23);
});

test('凭据探测超时：低于 1 秒一律退回 15 秒', () => {
  // 500ms 这种值看着「更积极」，实际会把每次探测变成一次高频请求，所以直接不认。
  assert.equal(settings({ apiKeyProbeTimeoutMs: 500 }).apiKeyProbeTimeoutMs, 15000);
  assert.equal(settings({ apiKeyProbeTimeoutMs: 2000 }).apiKeyProbeTimeoutMs, 2000);
});

test('主动说话的检查间隔有 1 秒下限与定时器上限', () => {
  assert.equal(settings({ proactiveCheckMs: 10 }).proactiveCheckMs, 1000);
  assert.equal(settings({ proactiveCheckMs: 10 ** 12 }).proactiveCheckMs, MAX_TIMER_MS);
});

test('复读门槛至少是 2（1 条相同的消息不算「连着出现」）', () => {
  assert.equal(settings({ repeatCount: 1 }).repeatCount, 2);
  assert.equal(settings({ repeatCount: 0 }).repeatCount, 2);
  assert.equal(settings({ repeatCount: 5 }).repeatCount, 5);
  assert.equal(settings({ repeatChance: 5 }).repeatChance, 1);
  assert.equal(settings({ repeatChance: -1 }).repeatChance, 0);
  // 0 = 不限长度的那个含义要保住（不能被当成「非法」清掉）。
  assert.equal(settings({ repeatMaxChars: 0 }).repeatMaxChars, 0);
  assert.equal(settings({ repeatMaxChars: 30 }).repeatMaxChars, 30);
});

test('画面指纹的宽松度夹在 0~0.3', () => {
  assert.equal(settings({ repeatImageTolerance: -1 }).repeatImageTolerance, 0);
  assert.equal(settings({ repeatImageTolerance: 1 }).repeatImageTolerance, 0.3);
  assert.equal(settings({ repeatImageTolerance: 0.08 }).repeatImageTolerance, 0.08);
});

test('多人搭话的倾听倍数只在 > 1 时生效', () => {
  assert.equal(settings({ activeGroupBatchScale: 0.5 }).activeGroupBatchScale, 1);
  assert.equal(settings({ activeGroupBatchScale: NaN }).activeGroupBatchScale, 1);
  assert.equal(settings({ activeGroupBatchScale: 3 }).activeGroupBatchScale, 3);
});

test('搭话抽卡的概率三项夹在 0~1，非法值保持 NaN（= 一句都不接）', () => {
  assert.equal(settings({ activeTalkChance: -1 }).activeTalkChance, 0);
  assert.equal(settings({ activeTalkChance: 5 }).activeTalkChance, 1);
  assert.equal(settings({ activeTalkChance: 0.4 }).activeTalkChance, 0.4);
  assert.equal(settings({ activeTalkChanceStep: 2 }).activeTalkChanceStep, 1);
  assert.equal(settings({ activeTalkChanceStep: -1 }).activeTalkChanceStep, 0);
  assert.equal(settings({ activeTalkChanceMax: 9 }).activeTalkChanceMax, 1);
  assert.equal(settings({ activeTalkChanceMax: -1 }).activeTalkChanceMax, 0);
  // 三项里 NaN 都**刻意不退回默认值**（与 proactiveChance 同口径）：它进到判据里会让
  // `roll < chance` 恒假 = 一句都不接，这比「按一个莫名其妙的概率乱接」安全得多。
  assert.ok(Number.isNaN(settings({ activeTalkChance: 'nonsense' }).activeTalkChance));
  assert.ok(Number.isNaN(settings({ activeTalkChanceStep: 'nonsense' }).activeTalkChanceStep));
  assert.ok(Number.isNaN(settings({ activeTalkChanceMax: 'nonsense' }).activeTalkChanceMax));
});

test('撤回调侃的四个数：概率夹在 0~1（NaN 保持 NaN = 不开口），毫秒/次数负数按 0 算', () => {
  assert.equal(settings({ recallChance: -1 }).recallChance, 0);
  assert.equal(settings({ recallChance: 5 }).recallChance, 1);
  assert.equal(settings({ recallChance: 0.5 }).recallChance, 0.5);
  // NaN 刻意不退回默认值：`roll < NaN` 恒假 = 一句都不补，比「按一个莫名其妙的概率乱开口」安全。
  assert.ok(Number.isNaN(settings({ recallChance: 'nonsense' }).recallChance));
  // 这三个是毫秒/次数，0 与负数都表示「不限」（与 pokeDailyMax 同口径）。
  assert.equal(settings({ recallCooldownMs: -1 }).recallCooldownMs, 0);
  assert.equal(settings({ recallDailyMax: -1 }).recallDailyMax, 0);
  assert.equal(settings({ recallMaxAgeMs: -1 }).recallMaxAgeMs, 0);
  assert.equal(settings({ recallCooldownMs: 'nonsense' }).recallCooldownMs, 60000);
  assert.equal(settings({ recallDailyMax: 'nonsense' }).recallDailyMax, 5);
  assert.equal(settings({ recallMaxAgeMs: 'nonsense' }).recallMaxAgeMs, 120000);
  // 默认值：不调侃（`ignore`），但**撤回就当没收到** —— 还没投给模型的那条真的不回，
  // 私聊也算；不给原文，只在转录里留一行标记。
  const defaults = settings({});
  assert.equal(defaults.recallMode, 'ignore');
  assert.equal(defaults.recallAddressed, 'drop');
  assert.equal(defaults.recallScope, 'to-me');
  assert.equal(defaults.recallTeaseQuote, false);
  assert.equal(defaults.recallPrivate, true);
  assert.equal(defaults.recallMemoryMark, true);
});

test('拆条相关的 0 都得保住「不限」的含义', () => {
  assert.equal(settings({ maxReplyChars: 0 }).maxReplyChars, 1500);
  assert.equal(settings({ burstMaxMessages: -1 }).burstMaxMessages, 0);
  assert.equal(settings({ burstMaxMessages: 1 }).burstMaxMessages, 1);
  assert.equal(settings({ burstMaxChars: 0 }).burstMaxChars, 0);
  assert.equal(settings({ burstSingleMaxChars: 0 }).burstSingleMaxChars, 0);
  assert.equal(settings({ burstMaxParts: 0 }).burstMaxParts, 1);
});

test('记忆的字节上限有 256 的地板（否则一个记忆文件都写不进去）', () => {
  assert.equal(settings({ memoryFileMaxBytes: 0 }).memoryFileMaxBytes, 256);
  assert.equal(settings({ memoryFileMaxBytes: 1024 }).memoryFileMaxBytes, 1024);
  assert.equal(settings({ digestMinLines: 0 }).digestMinLines, 1);
  assert.equal(settings({ memorySearchHits: 0 }).memorySearchHits, 40);
});

test('白名单去重去空白，但 allowUsers / allowGroups 保持逐字比较', () => {
  // 这两个列表原本就会被去重 + 去空白。
  assert.deepEqual(settings({ allowTools: [' read ', 'read', '', 'qq_send_message'] }).allowTools, ['read', 'qq_send_message']);
  assert.deepEqual(settings({ resetUsers: [' 123 ', '123'] }).resetUsers, ['123']);
  // 而这两个是**逐字**和消息里的 QQ 号比的：顺手 trim 会把「配了带空格的号」
  // 从「不匹配」变成「匹配」，那是放开白名单，属于安全面改动。这里钉住不做。
  assert.deepEqual(settings({ allowUsers: [' 123 '], allowGroups: [' 456 '] }).allowUsers, [' 123 ']);
  assert.deepEqual(settings({ allowGroups: [' 456 '] }).allowGroups, [' 456 ']);
});

test('cwd 留空时用传入的进程目录；非空时原样保留（含前后空白）', () => {
  assert.equal(settings({ cwd: '' }, '/work').cwd, '/work');
  assert.equal(settings({ cwd: '/srv/qq' }, '/work').cwd, '/srv/qq');
  // 非空即用，不去空白 —— 与旧行为一致（只判断「空不空」）。
  assert.equal(settings({ cwd: ' /srv/qq ' }, '/work').cwd, ' /srv/qq ');
});

test('主动说话的时段不做夹紧，交给 withinActiveHours 归一化', () => {
  // 这里刻意保持原样：`withinActiveHours` 对 NaN 的 to 会退化成 23（= 全天），
  // 若在这里先夹成 0，就变成「start === end」另一条分支了。两处口径必须一致。
  const shown = settings({ proactiveFromHour: 9, proactiveToHour: 23 });
  assert.equal(shown.proactiveFromHour, 9);
  assert.equal(shown.proactiveToHour, 23);
  const broken = settings({ proactiveFromHour: NaN, proactiveToHour: NaN });
  assert.ok(Number.isNaN(broken.proactiveFromHour));
  assert.ok(Number.isNaN(broken.proactiveToHour));
});

test('字符串项去空白，空白串按「没写」算', () => {
  assert.equal(settings({ resetCommand: ' /RESET ' }).resetCommand, '/reset');
  assert.equal(settings({ agentPreset: ' qq ' }).agentPreset, 'qq');
  assert.equal(settings({ persona: '   ' }).persona, '');
});

test('未再加工的字段原样透传（schema 已经保证类型与默认值）', () => {
  const s = settings({ groupTrigger: 'prefix', replyStyle: 'quote', humanize: false, stickerMaxFiles: 3 });
  assert.equal(s.groupTrigger, 'prefix');
  assert.equal(s.replyStyle, 'quote');
  assert.equal(s.humanize, false);
  assert.equal(s.stickerMaxFiles, 3);
  // memory !== false 这个口径（而不是直接取 memory）也要保住。
  assert.equal(settings({ memory: false }).memoryOn, false);
  assert.equal(settings({ memory: true }).memoryOn, true);
});

test('定时提醒：默认值、0 = 不限、非法值退回默认', () => {
  const s = settings();
  assert.equal(s.reminder, true);
  assert.equal(s.reminderFile, 'data/reminders.json');
  assert.deepEqual(s.reminderUsers, []);
  assert.equal(s.reminderMentionOthers, false);
  assert.equal(s.reminderAllowAll, false);
  assert.equal(s.reminderDailyMax, 5);
  assert.equal(s.reminderMaxActive, 20);
  assert.equal(s.reminderGraceMs, 10 * 60 * 1000);
  assert.equal(s.reminderModes, 'agent');
  assert.equal(s.reminderAgentTimeoutMs, 120000);
  assert.equal(s.reminderAgentDailyMax, 20);

  assert.equal(settings({ reminderDailyMax: 0 }).reminderDailyMax, 0, '0 是明确的不限');
  assert.equal(settings({ reminderDailyMax: -1 }).reminderDailyMax, 5, '负数不能变成不限');
  assert.equal(settings({ reminderDailyMax: NaN }).reminderDailyMax, 5);
  assert.equal(settings({ reminderMaxActive: 0 }).reminderMaxActive, 20);
  assert.equal(settings({ reminderMaxActive: 3 }).reminderMaxActive, 3);
  assert.equal(settings({ reminderModes: 'bogus' }).reminderModes, 'agent');
  assert.equal(settings({ reminderModes: 'prompt' }).reminderModes, 'prompt');
  assert.equal(settings({ reminderGraceMs: 'nonsense' }).reminderGraceMs, 600000);
  assert.equal(settings({ reminderGraceMs: -5 }).reminderGraceMs, 0);
  assert.equal(settings({ reminderAgentTimeoutMs: 100 }).reminderAgentTimeoutMs, 5000);
  assert.equal(settings({ reminderAgentDailyMax: -1 }).reminderAgentDailyMax, 20);
});

test('长期记忆 v2 的检索 / 人物 / 归档配置：默认值、0 与非法值各有明确去处', () => {
  const s = settings();
  assert.equal(s.memoryPromptChars, 6000);
  assert.equal(s.memoryRecallK, 12);
  assert.equal(s.memoryPeopleMax, 20);
  assert.equal(s.memoryArchive, true);
  assert.equal(s.memoryArchiveRatio, 0.75);
  assert.equal(s.memoryVocabHint, true);
  assert.equal(s.digestRollover, true);
  assert.equal(s.digestConsolidate, false);

  // 预算地板 200：低于它的「记忆」没有意义；非法值退回默认 6000。
  assert.equal(settings({ memoryPromptChars: 50 }).memoryPromptChars, 200);
  assert.equal(settings({ memoryPromptChars: NaN }).memoryPromptChars, 6000);
  assert.equal(settings({ memoryPromptChars: 0 }).memoryPromptChars, 6000);

  // 取条数有上下界：recallK 至少 1，peopleMax 的 0 是明确的「不注入人物」。
  assert.equal(settings({ memoryRecallK: 0 }).memoryRecallK, 1);
  assert.equal(settings({ memoryRecallK: 500 }).memoryRecallK, 100);
  assert.equal(settings({ memoryPeopleMax: 0 }).memoryPeopleMax, 0);
  assert.equal(settings({ memoryPeopleMax: -5 }).memoryPeopleMax, 0);
  assert.equal(settings({ memoryPeopleMax: 999 }).memoryPeopleMax, 200);

  // 滚档阈值夹在 0.1~1：0 会让每次写都滚，>1 则永远不滚。
  assert.equal(settings({ memoryArchiveRatio: 0 }).memoryArchiveRatio, 0.1);
  assert.equal(settings({ memoryArchiveRatio: 3 }).memoryArchiveRatio, 1);
  assert.equal(settings({ memoryArchiveRatio: NaN }).memoryArchiveRatio, 0.75);

  // 三个布尔开关：只有明确的 false / true 才改变默认，非法值不翻转语义。
  assert.equal(settings({ memoryArchive: false }).memoryArchive, false);
  assert.equal(settings({ memoryVocabHint: false }).memoryVocabHint, false);
  assert.equal(settings({ digestRollover: false }).digestRollover, false);
  assert.equal(settings({ digestConsolidate: true }).digestConsolidate, true);
  assert.equal(settings({ digestConsolidate: 'yes' }).digestConsolidate, false);
});
