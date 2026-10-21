/**
 * 集成测试分册：定时提醒（text / agent / 路由 / 权限）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-reminders.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { REMINDER_ROUTE_PATH } from '../reminders.js';
import { until, groupMessage, mention, completeTurn, boot, settle, bootGroupConversation, fireSchedulerAfter, fireReminderGuard } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


test('提醒：text 模式到点发固定文案，并 @ 创建者', async () => {
  const { onebot, host, agent } = await bootGroupConversation();
  try {
    const created = await host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 1 }, { agent });
    assert.equal(created.mode, 'text');
    assert.deepEqual(created.mentions, ['kaguya'], '默认 @ 创建者，名字用群名片');

    fireSchedulerAfter(host, 61_000);
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message)),
      'the reminder message',
    );
    assert.deepEqual(sent.params.message[0], { type: 'at', data: { qq: '100000003' } });
    assert.deepEqual(sent.params.message[1], { type: 'text', data: { text: '交作业' } });
  } finally {
    await onebot.close();
  }
});


test('提醒：agent 模式让模型说，@ 由插件注入', async () => {
  const { onebot, host, agent } = await bootGroupConversation();
  try {
    const created = await host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 1, mode: 'agent' }, { agent });
    assert.equal(created.mode, 'agent');

    fireSchedulerAfter(host, 61_000);
    await until(() => agent.inbox.length >= 2, 'the reminder nudge');
    completeTurn(host, agent, '该交作业了', 2);

    const sent = await until(
      () => onebot.calls.find(
        (call) =>
          call.action === 'send_group_msg' &&
          Array.isArray(call.params.message) &&
          call.params.message.some((segment) => segment.type === 'text' && segment.data.text === '该交作业了'),
      ),
      'the model reply',
    );
    assert.deepEqual(sent.params.message[0], { type: 'at', data: { qq: '100000003' } }, '@ 挂在第一条文字气泡前');
  } finally {
    await onebot.close();
  }
});


test('提醒：重启后没有会话记录时，agent 轮的模型回复仍然发得出去', async () => {
  // 模拟重启后的内存态：`conversations` 是空的，但磁盘上有一条到点的提醒。
  // `runReminderTurn` 会为它造一次性壳（不写进会话表）；turn/end 若先按 key 查会话
  // 再处理提醒，模型这一轮就白丢了，只剩 120 秒后的兜底文案（真实回归）。
  const { onebot, host } = await boot({ proactive: false, activeFollow: false, repeat: false });
  try {
    await host.tools.get('qq_remind_create').execute(
      { target_type: 'group', target_id: '100000001', text: '交作业', in_minutes: 1, mode: 'agent' },
      {},
    );
    fireSchedulerAfter(host, 61_000);
    const agent = await until(() => host.list.created[0], 'the reminder Agent');
    await until(() => agent.inbox.length >= 1, 'the reminder nudge');
    completeTurn(host, agent, '该交作业了', 1);

    // 操作员建的提醒没有默认 @，正文以纯字符串发出；这里只钉「模型回复没有被丢」。
    const sent = await until(
      () => onebot.calls.find((call) => {
        if (call.action !== 'send_group_msg') return false;
        const message = call.params.message;
        const text = typeof message === 'string'
          ? message
          : (Array.isArray(message) ? message.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('') : '');
        return text === '该交作业了';
      }),
      'the model reply from a restart reminder',
    );
    assert.ok(sent);
  } finally {
    await onebot.close();
  }
});


test('提醒：agent 轮判成 SKIP 时仍然发固定文案', async () => {
  const { onebot, host, agent } = await bootGroupConversation();
  try {
    await host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 1, mode: 'agent' }, { agent });
    fireSchedulerAfter(host, 61_000);
    await until(() => agent.inbox.length >= 2, 'the reminder nudge');
    completeTurn(host, agent, 'SKIP', 2);

    const sent = await until(
      () => onebot.calls.find(
        (call) =>
          call.action === 'send_group_msg' &&
          Array.isArray(call.params.message) &&
          call.params.message.some((segment) => segment.type === 'text' && segment.data.text === '交作业'),
      ),
      'the fallback text',
    );
    assert.deepEqual(sent.params.message[0], { type: 'at', data: { qq: '100000003' } });
    assert.equal(onebot.calls.filter((call) => Array.isArray(call.params.message) && call.params.message[0]?.type === 'at').length, 1, '只发一条');
  } finally {
    await onebot.close();
  }
});


test('提醒：agent 轮超时后发固定文案，迟到的回复被丢弃', async () => {
  const { onebot, host, agent } = await bootGroupConversation();
  try {
    await host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 1, mode: 'agent' }, { agent });
    fireSchedulerAfter(host, 61_000);
    await until(() => agent.inbox.length >= 2, 'the reminder nudge');

    fireReminderGuard(host);
    await until(
      () => onebot.calls.some(
        (call) =>
          call.action === 'send_group_msg' &&
          Array.isArray(call.params.message) &&
          call.params.message.some((segment) => segment.type === 'text' && segment.data.text === '交作业'),
      ),
      'the timeout fallback',
    );

    // 守卫已经结算过：这一轮迟到的回复不能再发第二条。
    completeTurn(host, agent, '迟到的回复', 2);
    await settle(150);
    const reminderMessages = onebot.calls.filter(
      (call) => call.action === 'send_group_msg' && Array.isArray(call.params.message) && call.params.message[0]?.type === 'at',
    );
    assert.equal(reminderMessages.length, 1, '超时兜底之后不再发模型回复');
    assert.ok(!onebot.calls.some((call) => String(call.params.message).includes('迟到的回复')), '迟到的正文不发送');
  } finally {
    await onebot.close();
  }
});


test('提醒：列表与取消', async () => {
  const { onebot, host, agent } = await bootGroupConversation();
  try {
    const created = await host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 5 }, { agent });
    const listed = await host.tools.get('qq_remind_list').execute({}, { agent });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.id);
    assert.equal(listed.tasks[0].status, 'active');

    const cancelled = await host.tools.get('qq_remind_cancel').execute({ id: created.id }, { agent });
    assert.equal(cancelled.status, 'cancelled');
    const after = await host.tools.get('qq_remind_list').execute({}, { agent });
    assert.equal(after.tasks.length, 0);
  } finally {
    await onebot.close();
  }
});


test('提醒：reminder=false 与文件在 cwd 外时不注册工具', async () => {
  const disabled = await boot({ reminder: false });
  try {
    assert.equal(disabled.host.tools.has('qq_remind_create'), false);
    assert.equal(disabled.host.tools.has('qq_remind_list'), false);
    assert.equal(disabled.host.tools.has('qq_remind_cancel'), false);
  } finally {
    await disabled.onebot.close();
  }

  const outside = await boot({ reminderFile: '../outside-reminders.json' });
  try {
    assert.equal(outside.host.tools.has('qq_remind_create'), false);
    assert.ok(outside.host.list.warnings.some((line) => line.includes('reminderFile')), '越界要记一条 warn');
  } finally {
    await outside.onebot.close();
  }
});


test('提醒：任务文件跨进程重启还在', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-reminder-cwd-'));
  const first = await bootGroupConversation({ cwd });
  let taskId;
  try {
    const created = await first.host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 30 }, { agent: first.agent });
    taskId = created.id;
  } finally {
    await first.onebot.close();
  }

  const second = await bootGroupConversation({ cwd });
  try {
    const listed = await second.host.tools.get('qq_remind_list').execute({}, { agent: second.agent });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, taskId);
  } finally {
    await second.onebot.close();
  }
});


test('提醒：设置页通过只读路由读到任务（认证由 Connection 负责）', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-reminder-view-'));
  await mkdir(join(cwd, 'data'), { recursive: true });
  const due = Date.now() + 60 * 60 * 1000;
  await writeFile(
    join(cwd, 'data', 'reminders.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'r-view',
          key: 'group:100000001',
          type: 'group',
          targetId: '100000001',
          mode: 'text',
          text: '交作业',
          fallbackText: '交作业',
          dueAt: due,
          status: 'active',
          createdAt: due - 1000,
          createdBy: '100000002',
          createdByName: '李四',
          fireCount: 0,
        },
      ],
    }),
  );
  const routes = [];
  const connection = {
    fetch: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  const instance = await boot({ cwd, reminderFile: 'data/reminders.json' }, { connection });
  try {
    const route = routes.find((candidate) => candidate.path === REMINDER_ROUTE_PATH);
    assert.ok(route, '设置页必须挂上读取任务的路由');
    assert.deepEqual(route.methods, ['GET']);
    assert.equal(route.requestBody, 'buffered');

    const response = await route.fetch(new Request(`http://127.0.0.1${REMINDER_ROUTE_PATH}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
    assert.equal(body.pending, 1);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].id, 'r-view');
    assert.equal(body.tasks[0].text, '交作业');
    assert.equal(body.tasks[0].createdBy, '李四');
    assert.equal(body.tasks[0].targetId, '100000001');
    assert.equal(body.tasks[0].status, 'active');
    assert.equal(Object.hasOwn(body.tasks[0], 'retryText'), false, '内部账不随路由泄漏出去');
  } finally {
    await instance.onebot.close();
  }
});


test('提醒：Connection 服务比插件晚就绪时，设置页路由照样挂上', async () => {
  // 真实 Host 的顺序：插件的 apply() 先跑完（配置日志一条不少），`dsh-client-connection`
  // 要等 web 表面起来（实测约 2 秒后）才 provide 出 `connection`。这里复现那个顺序 ——
  // 曾经用 `ctx.get('connection')` 探一次，探到的就是 undefined，于是路由永远挂不上，
  // 设置页那一块只能拿到 404（真实事故：任务真的建好了，页面上什么都没有）。
  const cwd = await mkdtemp(join(tmpdir(), 'qq-reminder-late-'));
  await mkdir(join(cwd, 'data'), { recursive: true });
  await writeFile(join(cwd, 'data', 'reminders.json'), JSON.stringify({ version: 1, tasks: [] }));
  const routes = [];
  const instance = await boot({ cwd, reminderFile: 'data/reminders.json' });
  try {
    assert.equal(routes.length, 0, '服务还没出现时不该凭空挂一条路由');
    // 模拟 web 表面起来：Connection 服务这一刻才出现。
    instance.host.list.provide('connection', {
      fetch: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    });
    const route = routes.find((candidate) => candidate.path === REMINDER_ROUTE_PATH);
    assert.ok(route, 'connection 晚到也必须补挂路由（否则设置页只有 404）');
    const body = await (await route.fetch(new Request(`http://127.0.0.1${REMINDER_ROUTE_PATH}`))).json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
  } finally {
    await instance.onebot.close();
  }
});


test('提醒：关掉提醒时设置页路由仍然报告「已关闭」', async () => {
  const routes = [];
  const connection = {
    fetch: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  const instance = await boot({ reminder: false }, { connection });
  try {
    const route = routes.find((candidate) => candidate.path === REMINDER_ROUTE_PATH);
    assert.ok(route, '提醒关掉时也要有路由，页面才能说清为什么是空的');
    const body = await (await route.fetch(new Request(`http://127.0.0.1${REMINDER_ROUTE_PATH}`))).json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, false);
    assert.deepEqual(body.tasks, []);
  } finally {
    await instance.onebot.close();
  }
});


test('提醒：prompt 模式与 @ 别人的权限在工具层就挡住', async () => {
  const { onebot, host, agent } = await bootGroupConversation({ reminderModes: 'prompt' });
  try {
    // 先让另一个人在这个群冒个泡（没 @ 机器人）：他只进 participants，不改「谁在跟它说话」。
    onebot.push(groupMessage([{ type: 'text', data: { text: '在吗' } }], { userId: 100000004, name: 'tomori', card: 'tomori', messageId: 7001 }));
    await settle(60);
    await assert.rejects(
      () => host.tools.get('qq_remind_create').execute({ prompt: '做点事', mode: 'prompt', in_minutes: 5 }, { agent }),
      /trusted users/,
      '普通群友不能建 prompt，即使 reminderModes 开着',
    );
    await assert.rejects(
      () => host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 5, mention: ['tomori'] }, { agent }),
      /other people/,
      '默认不能 @ 创建者以外的人',
    );
  } finally {
    await onebot.close();
  }

  // 创建白名单非空时，不在名单里的人连 text 都建不了。
  const limited = await bootGroupConversation({ reminderUsers: ['999999999'] });
  try {
    await assert.rejects(
      () => limited.host.tools.get('qq_remind_create').execute({ text: '交作业', in_minutes: 5 }, { agent: limited.agent }),
      /reminderUsers/,
    );
  } finally {
    await limited.onebot.close();
  }

  // 把这个人加进受信名单之后，两件事都放行（@ 的名字要在 participants 里）。
  const trusted = await bootGroupConversation({ reminderModes: 'prompt', reminderUsers: ['100000003'] });
  try {
    const created = await trusted.host.tools.get('qq_remind_create').execute(
      { prompt: '整理今天的群聊', mode: 'prompt', in_minutes: 5 },
      { agent: trusted.agent },
    );
    assert.equal(created.mode, 'prompt');
  } finally {
    await trusted.onebot.close();
  }
});
