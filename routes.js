/**
 * 设置页的 Host 路由：会话列表 / 重置，以及只读的定时任务看板。
 *
 * 为什么单独成模块：这一段只有 HTTP 形状（路径、方法、状态码、JSON），而真正的会话动作
 * （`webSessionSnapshots` / `resetConversationFromWeb`）留在 `index.js` —— 它们要碰会话
 * 队列与 `resetConversation`，路由模块不该知道这些。依赖由 `index.js` 显式传入。
 *
 * 两条硬约束（从 `index.js` 原样搬来，别改成一次性 `ctx.get('connection')`）：
 *
 *   1. **必须用 `ctx.inject`**：本插件的 `apply()` 跑在 `dsh-client-connection` 之前
 *      （实测启动日志：插件在 T+0s 打完整套配置，`dsh web: http://…` 在 T+2s 才出现），
 *      那一刻 `ctx.get('connection')` 是 undefined —— 于是路由**永远**挂不上，设置页
 *      只会拿到 404（真实事故：任务确实建好了，页面上却什么都没有）。
 *      `ctx.inject(['connection'], …)` 等的是「服务出现」这个事件：有了才跑回调，
 *      headless 组合里回调压根不跑，也不影响插件激活。
 *   2. **没有 Connection 服务时静默不挂** —— 那边也没有设置页。
 *
 * 路由的注销由 `connection.fetch.register` 自己挂的 effect 负责（它绑在回调拿到的那个
 * 子上下文上），插件卸载时一起收掉。
 *
 * @module @qqbot/dsh-plugin-qq/routes
 */
import { REMINDER_ROUTE_PATH } from './reminders.js';
import { SESSION_ROUTE_PATH, sessionIdFor } from './util.js';

/** 路由用的 JSON 响应：设置页是同源 fetch，一律不缓存。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 挂上设置页用到的两条路由。
 *
 * @param ctx - 插件的上下文（只用来 `ctx.inject`）。
 * @param deps - `reminders`（可能 undefined）/ `conversations` / `snapshots()` /
 *   `resetFromWeb(conversation)`，全部来自 `index.js` 的闭包。
 */
export function registerRoutes(ctx, { reminders, conversations, snapshots, resetFromWeb }) {
  // 设置页那一块「已记录的定时任务」要读的是**运行中的任务文件**，它不是配置项，
  // schema 里没有、也不能为了它加一个假的配置字段。于是挂一条只读的 Host 路由：
  // Connection 的 `/api` 自带 Host/Origin 栅栏与浏览器认证，页面（同源 fetch）拿到的
  // 就是操作员视角；数据本身走 `reminders.overview()`，只含展示字段。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection');
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    connection.fetch.register({
      path: REMINDER_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const at = Date.now();
        const body = reminders === undefined
          ? { ok: true, enabled: false, now: at, pending: 0, total: 0, tasks: [] }
          : { ok: true, enabled: true, ...(await reminders.overview(at)) };
        return jsonResponse(body);
      },
    });
  });

  // 设置页「重置对话」：与 QQ 里的 `/reset` 调同一个 `resetConversation`，只是入口换成
  // Web UI。为什么不复用 `resetUsers`：那是「群消息里谁能发这个指令」的白名单，而这条
  // 路由只在 Connection 的认证栅栏内、且只交给 owner principal（别的 principal 一律 403）
  // —— 能打开设置页的人本来就能改这份配置、重启进程，重置一个会话比那轻得多。
  //
  // 列表只读**这次进程**的 `conversations`：会话记录是内存态，重启后要等对方再发一条
  // 消息才会重新出现。这一点写在 docs/sessions.md，别让页面暗示「磁盘上所有会话」。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection');
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    connection.fetch.register({
      path: SESSION_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          return jsonResponse({ ok: true, now: Date.now(), conversations: snapshots() });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: 'invalid-json' }, 400);
        }
        // `{ all: true }`：设置页的「全部重置」。逐个排进各自的串行链，一个失败不拦其余。
        if (body?.all === true) {
          const reset = [];
          const failed = [];
          for (const conversation of [...conversations.values()]) {
            const key = conversation.key;
            if (await resetFromWeb(conversation)) {
              reset.push({
                key,
                round: conversation.sessionGeneration ?? 0,
                sessionId: sessionIdFor(key, conversation.sessionGeneration ?? 0),
              });
            } else {
              failed.push({ key, reason: 'dispose-failed' });
            }
          }
          // 全部重置是一次批处理：请求本身成功（200），逐项结果放在 `failed` 里，
          // 页面据此显示「重置了几个、失败几个」。单条重置的失败才用 4xx/5xx。
          return jsonResponse({ ok: true, reset, failed, conversations: snapshots() });
        }
        const key = typeof body?.key === 'string' ? body.key.trim() : '';
        if (key.length === 0) return jsonResponse({ ok: false, error: 'missing-key' }, 400);
        const conversation = conversations.get(key);
        if (conversation === undefined) {
          return jsonResponse(
            { ok: false, error: 'unknown-conversation', reset: [], failed: [{ key, reason: 'unknown-conversation' }] },
            404,
          );
        }
        if (!(await resetFromWeb(conversation))) {
          return jsonResponse(
            { ok: false, error: 'dispose-failed', reset: [], failed: [{ key, reason: 'dispose-failed' }] },
            409,
          );
        }
        return jsonResponse({
          ok: true,
          reset: [{
            key,
            round: conversation.sessionGeneration ?? 0,
            sessionId: sessionIdFor(key, conversation.sessionGeneration ?? 0),
          }],
          failed: [],
          conversations: snapshots(),
        });
      },
    });
  });
}
