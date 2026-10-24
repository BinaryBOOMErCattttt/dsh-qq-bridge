/**
 * `balance.js` 的单元测试：解析、渲染、鉴权失败。
 *
 * 运行：node --test test/balance.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchBalance, parseBalance, renderBalance } from '../balance.js';

test('parseBalance：字段可能是字符串，金额统一两位小数', () => {
  const parsed = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'cny', total_balance: '110.5', granted_balance: '10', topped_up_balance: '100.5' }],
  });
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.entries, [{ currency: 'CNY', total: '110.50', granted: '10.00', topped: '100.50' }]);
});

test('renderBalance：带货币符号；不可用 / 空列表都有人话', () => {
  assert.equal(
    renderBalance(parseBalance({ balance_infos: [{ currency: 'CNY', total_balance: 12.3, granted_balance: 2, topped_up_balance: 10.3 }] })),
    '余额：¥12.30（赠送 ¥2.00 / 充值 ¥10.30）',
  );
  assert.match(renderBalance(parseBalance({ is_available: false, balance_infos: [] })), /没有金额/);
  assert.match(renderBalance({ available: true, entries: [] }), /没有金额/);
});

test('fetchBalance：没 key / 401 / 正常响应', async () => {
  await assert.rejects(() => fetchBalance({ apiKey: '' }), /没拿到 API 凭据/);

  await assert.rejects(
    () => fetchBalance({ apiKey: 'k', fetchImpl: async () => ({ status: 401, ok: false }) }),
    /被拒绝/,
  );

  const parsed = await fetchBalance({
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      assert.match(url, /\/user\/balance$/);
      assert.equal(init.headers.authorization, 'Bearer k');
      return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }) };
    },
  });
  assert.equal(parsed.entries[0].total, '1.00');
});
