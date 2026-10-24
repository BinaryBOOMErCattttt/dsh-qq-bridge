/**
 * 余额指令：读 DeepSeek 的 `/user/balance`。
 *
 * 只做两件事：按 `apiKeyRef` 拿到的 key 发一个 GET，再把 `balance_infos` 拼成人话。
 * 不缓存（余额随时在变）、不重试（重试只会多打一次接口，失败就说失败）。
 *
 * @module @qqbot/dsh-plugin-qq/balance
 */

/** 货币 → 符号。认不出的货币原样写代码（`SGD 12.00` 比 `¤12.00` 有用）。 */
const CURRENCY_SYMBOL = new Map([
  ['CNY', '¥'],
  ['RMB', '¥'],
  ['USD', '$'],
  ['EUR', '€'],
]);

/** 一档余额的数字。 */
function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : String(value ?? '?');
}

/**
 * 解析 `/user/balance` 的响应。
 *
 * DeepSeek 的形状是 `{ is_available, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }`；字段偶尔是字符串（API 把金额当十进制字符串
 * 返回），所以这里一律按 Number 处理。
 * @param {unknown} body
 * @returns {{ available: boolean, entries: Array<{ currency: string, total: string, granted: string, topped: string }> }}
 */
export function parseBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  return {
    available: body?.is_available !== false,
    entries: infos.map((info) => ({
      currency: String(info?.currency ?? 'CNY').toUpperCase(),
      total: money(info?.total_balance),
      granted: money(info?.granted_balance),
      topped: money(info?.topped_up_balance),
    })),
  };
}

/**
 * 请求余额。
 * @param {{ apiKey: string, url?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<ReturnType<typeof parseBalance>>}
 */
export async function fetchBalance({ apiKey, url = 'https://api.deepseek.com/user/balance', fetchImpl = fetch, timeoutMs = 8000 }) {
  const key = String(apiKey ?? '').trim();
  if (key.length === 0) throw new Error('没拿到 API 凭据（apiKeyRef 指向的 key 为空）');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) throw new Error('API key 被拒绝（401/403），检查凭据或轮换池');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseBalance(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把余额拼成 QQ 里能读的一行 / 几行。
 * @param {ReturnType<typeof parseBalance>} parsed
 * @returns {string}
 */
export function renderBalance(parsed) {
  if (!Array.isArray(parsed?.entries) || parsed.entries.length === 0) {
    return '没有金额信息（可能这个 key 没有余额信息）。';
  }
  const lines = parsed.entries.map((entry) => {
    const symbol = CURRENCY_SYMBOL.get(entry.currency) ?? `${entry.currency} `;
    return `余额：${symbol}${entry.total}（赠送 ${symbol}${entry.granted} / 充值 ${symbol}${entry.topped}）`;
  });
  if (parsed.available === false) lines.unshift('账户当前不可用。');
  return lines.join('\n');
}
