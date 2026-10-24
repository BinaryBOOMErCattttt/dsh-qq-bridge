/**
 * 零 token 小玩意的纯函数：运势签、骰子、硬币、随机点名。
 *
 * 全部是「同样输入 → 同样输出」或「注入随机源」，可以脱离 QQ / Harness 单测。
 * 运势按「QQ 号 + 日期」哈希，所以同一天问几次都是同一签，不会前后矛盾。
 *
 * @module @qqbot/dsh-plugin-qq/fun
 */

const FORTUNES = [
  { level: '大吉', advice: '适合摸鱼，摸到的鱼最大', lucky: '米饭' },
  { level: '中吉', advice: '适合接梗，但别接太多', lucky: '蛋挞' },
  { level: '小吉', advice: '适合安静地吃一碗饭', lucky: '海苔' },
  { level: '吉', advice: '适合被夸，也适合夸别人', lucky: '鱼干' },
  { level: '末吉', advice: '适合晚点再干活', lucky: '汽水' },
  { level: '凶', advice: '不宜加班，宜趴着', lucky: '枕头' },
  { level: '大凶', advice: '今天适合什么都不做', lucky: '被窝' },
];

/** FNV-1a 32 位哈希：稳定、够短、不需要依赖。 */
export function hash32(text) {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 今日运势。
 * @param {{ userId: string, date: string, salt?: string }} input - 谁、哪一天（YYYY-MM-DD）。
 * @returns {{ level: string, advice: string, lucky: string, index: number }}
 */
export function dailyFortune({ userId, date, salt = '' }) {
  const hash = hash32(`${userId}:${date}:${salt}`);
  const index = hash % FORTUNES.length;
  return { ...FORTUNES[index], index };
}

/**
 * 解析骰子参数：`d6` / `2d6` / `3d20` / `6`（裸数字按 1dN）。
 * 上限挡住「100d100」这种刷屏参数。
 * @param {unknown} text
 * @returns {{ count: number, sides: number }}
 */
export function parseDice(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const match = /^(\d{0,2})d(\d{1,3})$/u.exec(raw) ?? /^(\d{1,3})$/u.exec(raw);
  if (match === null) throw new Error('骰子要写成 d6 / 2d6 / 3d20（或直接给面数）');
  const count = match[2] === undefined ? 1 : Math.max(1, Number(match[1] || 1));
  const sides = Math.max(2, Number(match[2] ?? match[1]));
  if (count > 10) throw new Error('一次最多 10 颗骰子');
  if (sides > 100) throw new Error('骰子最多 100 面');
  return { count, sides };
}

/**
 * 掷骰子。
 * @param {{ count: number, sides: number }} spec
 * @param {() => number} [random] - 0~1 随机源（测试注入）。
 * @returns {{ rolls: number[], total: number }}
 */
export function rollDice(spec, random = Math.random) {
  const rolls = [];
  for (let index = 0; index < spec.count; index += 1) {
    rolls.push(1 + Math.floor(random() * spec.sides));
  }
  return { rolls, total: rolls.reduce((sum, value) => sum + value, 0) };
}

/** 抛硬币：0 正面 / 1 反面。 */
export function flipCoin(random = Math.random) {
  return random() < 0.5 ? '正面' : '反面';
}

/** 从数组里随机取一个（空数组返回 undefined）。 */
export function pickRandom(list, random = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list[Math.floor(random() * list.length)];
}

/** 运势签的排版：三行，群里一眼能看完。 */
export function formatFortune(fortune, name) {
  return [
    `${name} 今日运势：${fortune.level}`,
    `· 宜：${fortune.advice}`,
    `· 幸运物：${fortune.lucky}`,
  ].join('\n');
}
