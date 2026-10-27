/**
 * 话题记忆：高 / 中 / 低 / 冷四档，按「模式轮数」自动降档。
 *
 * 为什么需要它：长期记忆（`.qq-memory/`）记的是**事实**（谁喜欢什么、发生过什么），
 * 但聊天里真正在推进的是**话题** —— 「这次在聊搬家」「群友在等一个比赛」。这些话题
 * 反复出现、对之后明显重要，却既不是人设也不是记忆条目。模型自己判断哪几条值得留，
 * 插件只做三件机械的事：落盘、按轮数降档、把高檔的短摘要摆回提示词。
 *
 * 为什么用「轮数」而不是时间：话题的热度跟「群里又说了多少句」有关，跟墙上时钟无关 ——
 * 半夜没人说话，八小时过去话题也不该掉档。
 *
 * 四档语义（照快照口径）：
 *   - `high`（常驻）：短摘要每轮都进「本轮情境」，最多 6 条；
 *   - `medium`（按需）：只在状态里看得见，模型需要时用 qq_transcript / qq_topic 查；
 *   - `low`（低档）：压成一句话，同样不主动注入；
 *   - `cold`（冷区）：完全退出提示词，只是留个名字（不再降档）。
 *
 * 状态存在 `data/chat-state.json` 的 `topics` 段（与米饭 / 心情共用一本账），
 * 另外在 `data/TOPICS.md` 写一份人可读的镜像 —— 那是给人看的，读它的是外部 agent，
 * 不是运行时逻辑（运行时只读 json，坏文件不会让功能失效）。
 *
 * 这个模块只碰 `gameData` / `save` 与写文件这几个**由 index.js 递进来的动作**，
 * 不 import `index.js`（会成环），也不自己建状态 —— 单测可以喂一份假账本。
 *
 * @module @qqbot/dsh-plugin-qq/topics
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorText } from './util.js';
import { writeTextAtomic } from './filestore.js';

/** 档位从热到冷。降档就是往后挪一格。 */
export const TOPIC_TIERS = ['high', 'medium', 'low', 'cold'];

/** 档位的中文名（回复 / TOPICS.md / 状态共用）。 */
export const TOPIC_LABEL = { high: '常驻', medium: '按需', low: '低档', cold: '冷区' };

/** 每个会话最多留几条话题：超了丢最久没被提到的那条（按最近轮次排序）。 */
export const TOPIC_MAX = 50;

/** 注入提示词的常驻摘要条数上限：再多就把「本轮情境」挤掉了。 */
export const TOPIC_BRIEF_MAX = 6;

/**
 * 多少轮没被提及就降一档。
 *
 * 简洁模式 6 轮、其它模式 15 轮：简洁模式的承诺是「只参考最近 6 轮」，话题却记着
 * 二十轮前的东西，两者会打架。数值与 `mode.js` 的轮数口径保持一致。
 * @param {string} mode - 当前运行模式。
 * @returns {number} 轮数。
 */
export function topicDecayTurns(mode) {
  return mode === 'simple' ? 6 : 15;
}

/** 认不出的档位一律按 `medium`（模型偶尔写 `HIGH` / `中`，别让它整条被丢掉）。 */
export function normalizeTier(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  return TOPIC_TIERS.includes(text) ? text : 'medium';
}

/**
 * 降一档：`high → medium → low → cold`，冷区不再降。
 *
 * 纯函数、就地改传入的条目（调用方拿到的是账本里的对象，改完自己 save）。
 * @param {object[]} list - 话题数组（`{ topic, tier, lastRound }`）。
 * @param {number} nowRound - 这一轮是第几轮。
 * @param {number} turns - 多少轮没提就降档。
 * @returns {boolean} 有没有真的降过（决定要不要写盘）。
 */
export function decayTopics(list, nowRound, turns) {
  let changed = false;
  const window = Math.max(1, Math.floor(Number(turns) || 1));
  for (const topic of Array.isArray(list) ? list : []) {
    if (topic === null || typeof topic !== 'object') continue;
    if (topic.tier === 'cold') continue;
    const last = Number(topic.lastRound ?? 0);
    if (nowRound - last < window) continue;
    const index = TOPIC_TIERS.indexOf(normalizeTier(topic.tier));
    topic.tier = TOPIC_TIERS[Math.min(TOPIC_TIERS.length - 1, index + 1)];
    // 降档之后重新起算：不然下一轮又满足条件，一档档连降到底。
    topic.lastRound = nowRound;
    changed = true;
  }
  return changed;
}

/**
 * 建一个话题账本。
 *
 * @param deps - 依赖表：
 *   - `gameData(name)`：取 `data/chat-state.json` 的一段；
 *   - `save()`：标脏落盘（chat-state 自己合并写盘）；
 *   - `appModeOf()`：现读运行模式（决定轮数窗口）；
 *   - `cwd`：`data/TOPICS.md` 落在这里；
 *   - `report(level, message)`：日志。
 * @returns 见文件末尾的返回对象。
 */
export function createTopicStore({ gameData, save = () => {}, appModeOf = () => 'full', cwd, report = () => {} }) {
  /** 这个会话现在是第几轮（只数「有人跟它说话」的轮次）。 */
  function roundOf(conversation) {
    if (!Number.isFinite(conversation.topicRound)) conversation.topicRound = 0;
    return conversation.topicRound;
  }

  /** 这个会话的话题数组（就地挂在账本上，写盘由调用方 save）。 */
  function topicsFor(conversation) {
    const all = gameData('topics');
    if (!Array.isArray(all[conversation.key])) all[conversation.key] = [];
    return all[conversation.key];
  }

  /** 当前模式的降档窗口。 */
  function turns() {
    return topicDecayTurns(appModeOf());
  }

  /**
   * 每次有人说话先走一次：轮次 +1，超过窗口没被提到的话题降一档。
   *
   * 放在「这条消息真的交给模型」那一支（与心情衰减同一处）：没 @ 它的群消息不该推进
   * 话题轮次，否则一个热闹的群能把某个人的话题一路降到底。
   * @param conversation - 目标会话。
   */
  function decay(conversation) {
    conversation.topicRound = roundOf(conversation) + 1;
    const changed = decayTopics(topicsFor(conversation), conversation.topicRound, turns());
    if (!changed) return;
    save();
    void writeFile();
  }

  /**
   * 模型登记 / 更新一个话题：档位由模型判断，插件只落盘 + 写镜像。
   * @param conversation - 目标会话。
   * @param args - `{ topic, tier, summary }`（来自 qq_topic 的参数）。
   * @returns 落盘后的那一条（带中文档位名）。
   */
  function set(conversation, { topic, tier, summary } = {}) {
    const name = String(topic ?? '').trim().slice(0, 80);
    if (name.length === 0) throw new Error('话题名不能为空');
    const nextTier = normalizeTier(tier);
    const text = String(summary ?? '').trim().slice(0, 200);
    const list = topicsFor(conversation);
    const nowRound = roundOf(conversation);
    let hit = list.find((item) => item?.topic === name);
    if (hit === undefined) {
      hit = { topic: name, tier: nextTier, summary: text, lastRound: nowRound, at: Date.now() };
      list.push(hit);
    } else {
      hit.tier = nextTier;
      if (text.length > 0) hit.summary = text;
      hit.lastRound = nowRound;
      hit.at = Date.now();
    }
    // 超上限时丢最久没被提到的那条：按最近轮次降序，尾巴切掉。
    list.sort((left, right) => Number(right.lastRound ?? 0) - Number(left.lastRound ?? 0));
    if (list.length > TOPIC_MAX) list.length = TOPIC_MAX;
    save();
    void writeFile();
    return { ...hit, label: TOPIC_LABEL[hit.tier] };
  }

  /**
   * 常驻摘要（只取 `high`）：模型每轮都能看到「现在在聊什么」。
   *
   * 降档之后它自然从这里消失 —— 不额外维护一份「该删了」的名单。
   * @param conversation - 目标会话。
   * @returns 一行一条的摘要数组。
   */
  function briefLines(conversation) {
    return topicsFor(conversation)
      .filter((topic) => topic?.tier === 'high')
      .slice(0, TOPIC_BRIEF_MAX)
      .map((topic) => `- ${topic.topic}：${topic.summary || '（常驻话题）'}`);
  }

  /**
   * 写一份人可读的 `data/TOPICS.md`。
   *
   * 与快照的差别：快照只写**当前会话**，于是两个群来回切的时候这份文件一直在互相覆盖。
   * 这里把所有会话一起写出来（当前会话排在最前面），文件才真的是「一份现状」。
   * 失败只记 warn：镜像文件不是运行时依赖。
   */
  async function writeFile() {
    if (cwd === undefined) return;
    try {
      const all = gameData('topics');
      const keys = Object.keys(all).filter((key) => Array.isArray(all[key]) && all[key].length > 0);
      const lines = [
        '# 话题记忆',
        '',
        `模式轮数：${turns()}（超过未提及自动降一档，最低冷区）`,
        '',
      ];
      if (keys.length === 0) lines.push('（还没有登记过话题。）', '');
      for (const key of keys) {
        lines.push(`## ${key}`, '');
        lines.push('| 话题 | 档位 | 摘要 | 最近轮 |', '|---|---|---|---|');
        for (const topic of all[key]) {
          lines.push(
            `| ${topic.topic} | ${TOPIC_LABEL[topic.tier] ?? topic.tier} | ${topic.summary || ''} | ${topic.lastRound ?? 0} |`,
          );
        }
        lines.push('');
      }
      await mkdir(join(cwd, 'data'), { recursive: true });
      await writeTextAtomic(join(cwd, 'data', 'TOPICS.md'), lines.join('\n'));
    } catch (error) {
      report('warn', `topics md write failed: ${errorText(error)}`);
    }
  }

  return { roundOf, topicsFor, turns, decay, set, briefLines, writeFile };
}
