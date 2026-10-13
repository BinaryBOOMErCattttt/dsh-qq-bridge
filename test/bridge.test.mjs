/**
 * QQ 桥接插件的集成测试。
 *
 * 每个用例都会起一个假的 OneBot v11 WebSocket 服务端 + 一个假的 Harness Host
 * 上下文，然后跑完整往返：入站 QQ 事件 → 投递给 Agent → 持久化 turn 事件 →
 * OneBot 发送。这里用的是真实的插件模块、真实的 OneBot 客户端、真实的
 * `createUserMessage`（消息 id 由真实实现生成），只有 Harness 服务是桩。
 *
 * 运行：node --test test/bridge.test.mjs
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import yaml from 'js-yaml';
import { Config, apply, inject, withinActiveHours } from '../index.js';
import { collectMedia, mediaLabel, mediaPlaceholder, mentionsOthers, messageToText, repeatableText, splitBurst, splitStickerLines, typingDelayMs } from '../onebot.js';
import { createMediaStore, sniffImageExtension } from '../media.js';
import { imageSegment, loadOutgoingImage } from '../image.js';
import { OTHER_PNG, PIC_JPEG, PIC_PNG } from './image-fixtures.mjs';

/** 测试用机器人自己的 QQ 号。 */
const SELF_ID = 100000000;

/**
 * 一个真的 1×1 PNG（67 字节，8bit RGBA）。
 * 用真图而不是随便几个字节：落盘的是不是原字节、魔数识别对不对，都要靠它来验证。
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  'base64',
);

/** 起一个只有一个图片路由的 HTTP 服务，用来假装腾讯的图片 CDN。 */
async function startImageServer(body = TINY_PNG, { status = 200, contentType = 'image/png' } = {}) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (status !== 200) {
      response.writeHead(status);
      response.end('nope');
      return;
    }
    response.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    hits,
    body,
    url: (path = '/image') => `http://127.0.0.1:${server.address().port}${path}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 起一个最小 OneBot v11 服务端，并记录收到的每一次 API 调用。
 * @param options.getImage - `get_image` 的桩响应（不传则像多数实现一样报「不支持」）。
 * @param options.getMsg - `get_msg` 的桩响应：`(params) => 消息对象`（不传则报「不支持」）。
 * @param options.uploadFails - 给出时，`upload_*_file` 一律失败（用来验证「文件发不出去」的降级）。
 */
async function startFakeOneBot({ getImage, getMsg, uploadFails } = {}) {
  const calls = [];
  // 端口 0 = 让系统分配空闲端口，避免与真实 NapCat（3001）或并行测试冲突。
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      calls.push({ action: frame.action, params: frame.params });
      void respond(socket, frame);
    });
    socket.on('error', () => {});
  });

  /** 按 action 返回桩数据：`get_image` 走注入的桩，其余是固定应答。 */
  async function respond(socket, frame) {
    try {
      const data = await dataFor(frame);
      // 回显 echo 才能让插件的 call() 正确配对。
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data }));
    } catch (error) {
      socket.send(JSON.stringify({ status: 'failed', retcode: 1, echo: frame.echo, message: String(error?.message ?? error) }));
    }
  }

  async function dataFor(frame) {
    if (frame.action === 'get_login_info') return { user_id: SELF_ID, nickname: '小助手' };
    if (frame.action === 'get_group_info') return { group_id: frame.params.group_id, group_name: '示例群' };
    if (frame.action === 'get_group_list') return [{ group_id: 100000001, group_name: '示例群' }];
    if (frame.action === 'get_friend_list') return [{ user_id: 100000002, nickname: 'iroha' }];
    if (frame.action === 'get_image') {
      if (getImage === undefined) throw new Error('get_image is not supported by this fake');
      return await getImage(frame.params);
    }
    if (frame.action === 'get_msg') {
      if (getMsg === undefined) throw new Error('get_msg is not supported by this fake');
      return await getMsg(frame.params);
    }
    // 文件上传：默认成功（返回一个 file_id），需要验证降级时由 uploadFails 强制失败。
    if (frame.action === 'upload_private_file' || frame.action === 'upload_group_file') {
      if (uploadFails !== undefined) throw new Error(uploadFails);
      return { file_id: 'fake-file-id' };
    }
    // 未知 action 一律当作发送类接口返回一个 message_id。
    return { message_id: 1 };
  }

  return {
    calls,
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    /** 向所有已连接的插件 socket 推一条事件。 */
    push(event) {
      for (const socket of sockets) socket.send(JSON.stringify({ ...event, self_id: SELF_ID, time: 1 }));
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 造一个假 Host 上下文：记录注册信息，并可手动驱动事件。
 *
 * `presets` 传入 `{ default, compositions }` 时假装部署里存在 Agent 预设平面
 * （`dsh-web-app` 的默认形态）：`resolve()`/`mount()` 的行为与真实注册表一致 ——
 * 预设里的工具只有在 Agent join 之后才成为它继承来的工具。
 */
function makeHost({
  knownTools = ['qq_send_message', 'qq_list_conversations', 'read', 'bash'],
  sessionsRoot,
  presets,
  /** 真实宿主的 cordis LoggerService 门面带 exporter()；带上它插件会额外镜像一份到 stderr。 */
  loggerExporter = false,
} = {}) {
  const listeners = new Map();
  const tools = new Map();
  const agents = new Map();
  const prompts = [];
  const created = [];
  const warnings = [];
  const disposers = [];
  const cleanups = [];
  /**
   * 假 timer 服务：把 `ctx.timeout` / `ctx.interval` 的定时器**收集起来**而不是真的排期。
   *
   * 长期记忆的摘要循环故意是「按小时」量级的，测试不可能等它；所以由用例自己决定
   * 什么时候让定时器醒来（`host.list.timers.fire()`）。这样验的是插件的调度判定本身，
   * 而不是 Node 的定时器精度。
   */
  const timers = { timeouts: [], intervals: [], cleared: new Set() };
  /** 用例把 `host.list.stallIdle` 置真后创建的 Agent，`whenIdle()` 永不 resolve。 */
  let stalledIdle = false;
  /** 每次摘要都挂一个超时守卫；用例可以伪造「卡住」来验证超时后的自愈。 */
  const fakeTimer = {
    timeout(callback, delay) {
      const entry = { callback, delay, kind: 'timeout' };
      timers.timeouts.push(entry);
      return () => timers.cleared.add(entry);
    },
    interval(callback, delay) {
      const entry = { callback, delay, kind: 'interval' };
      timers.intervals.push(entry);
      return () => timers.cleared.add(entry);
    },
  };
  /**
   * 复现 cordis 的 inject 检查：没在 `inject` 里声明 `timer` 的插件碰不到 timer 服务。
   * 报错文案与 cordis 保持一致，方便对着真宿主的日志认。
   */
  const requireTimerService = () => {
    if (!inject.includes('timer')) throw new Error('cannot get property "timer" without inject');
  };
  // 记录每一次成功生效的工具收窄：{ sessionId, filter }。
  const restrictions = [];
  // join 过的预设（按 Agent），以及 create 时收到的 meta。
  const mountedPresets = [];
  const metas = [];
  // 被销毁的 Agent（按 sessionId），用于断言 /reset 真的销毁了活着的 Agent。
  const disposed = [];
  // 这个 Agent 继承得到的工具名：初始是宿主平面的全局工具，join 预设后再并入预设的工具
  // —— 与真实 `tools.view(scope).restrictableNames` 的「宿主编 + 祖先编」语义一致。
  const known = new Set(knownTools);
  const presetService =
    presets === undefined
      ? undefined
      : {
          async resolve(id) {
            const wanted = id ?? presets.default;
            if (!Object.hasOwn(presets.compositions, wanted)) throw new Error(`Unknown agent preset: ${wanted}`);
            return { id: wanted };
          },
          async mount(_agentCtx, id) {
            if (!Object.hasOwn(presets.compositions, id)) throw new Error(`Unknown agent preset: ${id}`);
            mountedPresets.push(id);
            for (const name of presets.compositions[id]) known.add(name);
          },
        };
  const ctx = {
    // warn 会被收集起来，方便断言/排查插件上报的异常。
    logger: {
      info() {},
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
      ...(loggerExporter ? { exporter: () => () => {} } : {}),
    },
    agents: {
      get: (id) => agents.get(id),
      // 默认模拟「没有可恢复的会话」，于是插件会走 create 分支。
      async resume() {
        throw new Error('no persisted session');
      },
      async create(options) {
        // create 时宿主会调用 setup；插件在其中 join 预设、注入模型变量、施加工具白名单，
        // 并注册 QQ 渠道提示小节。
        const agentCtx = {
          get: (service) =>
            service === 'systemPrompt'
              ? {
                  section: (s) => prompts.push({ kind: 'section', ...s }),
                  variable: (name, provider) => prompts.push({ kind: 'variable', name, provider }),
                }
              : undefined,
          // 真实宿主里 agentCtx.tools 是作用域绑定的服务：restrict() 只收窄这个
          // Agent，且遇到它继承不到的工具名会抛错 —— 这里如实照搬这两条语义。
          tools: {
            restrict(filter) {
              const unknown = [...(filter.allow ?? []), ...(filter.deny ?? [])].filter((name) => !known.has(name));
              if (unknown.length > 0) throw new Error(`tools.restrict() names unknown tool ${unknown.join(', ')}`);
              restrictions.push({ sessionId: options.sessionId, filter });
              return () => {};
            },
            get: (name) => (known.has(name) ? { name } : undefined),
          },
        };
        await options.setup?.(agentCtx, { id: options.sessionId });
        // 最小 Agent 桩：只保留插件真正用到的 id / options / inbox / followup / whenIdle。
        const agent = {
          id: options.sessionId,
          options: options.agentOptions,
          inbox: [],
          followup(message) {
            this.inbox.push(message);
          },
          /** 摘要链路会 `await agent.whenIdle()`；桩里这一轮「已经结束了」。 */
          whenIdle() {
            // `host.list.stallIdle = true` 模拟一个卡死的模型请求：永不 resolve，
            // 用来验证摘要的硬超时会把这个 Agent 收掉（而不是让摘要永远排队）。
            if (stalledIdle) return new Promise(() => {});
            return Promise.resolve();
          },        };
        agents.set(options.sessionId, agent);
        created.push(agent);
        metas.push({ sessionId: options.sessionId, meta: options.meta });
        // 模拟 jsonl 后端：create 时在会话根目录下落地一条持久化记录，
        // /reset 必须把它删掉，否则下一条消息又会 resume 出旧记忆。
        if (sessionsRoot !== undefined) {
          const dir = join(sessionsRoot, '--fake-project--', options.sessionId);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub');
        }
        return {
          agent,
          // dispose 是幂等的，并让 Agent 从 ctx.agents 里消失（与真实宿主一致）。
          dispose: async () => {
            if (!agents.delete(options.sessionId)) return;
            disposed.push(options.sessionId);
          },
        };
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    on(event, handler) {
      const entry = listeners.get(event) ?? [];
      entry.push(handler);
      listeners.set(event, entry);
      return () => {};
    },
    // ctx.effect 的回调被收集起来，由 list.start() 真正执行（启动 OneBot 连接）。
    effect(body) {
      disposers.push(body);
      return () => {};
    },
    // 真宿主上这两个来自 @deepseek-ai/cordis-plugin-timer 服务的 `ctx.mixin('timer', ...)`；
    // 这里转发到假定时器，好让用例自己决定「摘要循环什么时候醒」。
    //
    // 但要连 cordis 的 inject 检查一起复现：真宿主只允许插件访问 inject 里声明过的服务，
    // `inject` 漏了 'timer' 时取 `ctx.interval` 就抛错、apply() 整个失败（bot 不回复）。
    // 桩若比真宿主宽松，这类事故就会「测试全绿但线上不激活」（真实发生过一次），所以
    // 缺声明时这里也抛同样的错，让它在测试里就炸出来。
    timeout(callback, delay) {
      requireTimerService();
      return fakeTimer.timeout(callback, delay);
    },
    interval(callback, delay) {
      requireTimerService();
      return fakeTimer.interval(callback, delay);
    },
    get(service) {
      // 模拟部署默认模型选择，验证「配置为空时继承默认值」。
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }) };
      }
      if (service === 'approval') return { setPolicy() {} };
      // 定时器服务：插件用它排摘要循环（见上面 timeout / interval）。
      if (service === 'timer') return fakeTimer;
      // Agent 预设平面：只有传了 presets 的用例才有（与 headless 组合形成对照）。
      if (service === 'agentPresets') return presetService;
      // 会话持久化后端：插件用它的 root 定位要删除的会话目录。
      if (service === 'sessionPersistence' && sessionsRoot !== undefined) return { root: sessionsRoot };
      return undefined;
    },
  };
  return {
    ctx,
    tools,
    list: {
      get stallIdle() {
        return stalledIdle;
      },
      set stallIdle(value) {
        stalledIdle = value === true;
      },
      created,
      prompts,
      warnings,
      restrictions,
      disposed,
      mountedPresets,
      metas,
      /** 把一条事件跑过所有已注册的监听器（模拟 Harness 事件总线）。 */
      emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) handler(...args);
      },
      start() {
        // ctx.effect 的返回值是「销毁回调」：真实宿主在插件卸载时调用它。
        // 这里把它们存起来，供 list.stop() 在用例结束时收尾（否则测试进程会
        // 挂着一堆监听中的 socket 不肯退出）。
        for (const body of disposers) {
          const cleanup = body();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        }
      },
      stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
      },
      timers: {
        /** 目前还活着的定时器（没被 disposer 清掉的）。 */
        live(kind) {
          return timers[kind].filter((entry) => !timers.cleared.has(entry));
        },
        /**
         * 让所有活着的周期定时器醒一次（摘要循环就是挂在它上面的）。
         * 回调是同步触发 `runDigestSweep` 的，真正的摘要是异步的 —— 所以用例
         * 还需要再等摘要状态落盘。
         */
        fireInterval() {
          for (const entry of this.live('intervals')) entry.callback();
        },
        /** 让所有活着的超时定时器醒一次（摘要的硬超时守卫）。 */
        fireTimeout() {
          for (const entry of this.live('timeouts')) entry.callback();
        },
      },
    },
  };
}

/**
 * 取某个已注册提示小节的文本。
 *
 * `text` 现在既可能是字符串，也可能是 provider 函数（插件用它让「当前发言者」
 * 与群聊上下文每次都重新求值），所以测试统一走这里，而不是直接读 `entry.text`。
 */
function promptText(host, name) {
  const entry = host.list.prompts.find((item) => item.kind === 'section' && item.name === name);
  assert.ok(entry, `prompt section ${name} should be registered`);
  return typeof entry.text === 'function' ? entry.text({}) : entry.text;
}

/** 轮询等待直到 `check` 返回真值；超时则测试失败。 */
async function until(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `await` 让异步断言（例如「等工具能从磁盘上读到两条转录」）也能直接用这个轮询。
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 造一条私聊入站事件（发送者固定为该测试 QQ 号）。 */
function privateMessage(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 100000002,
    sender: { nickname: 'iroha' },
    message: [{ type: 'text', data: { text } }],
  };
}

/**
 * 造一条「私聊里发了一张图（后面还可能跟一句话）」的事件。
 * 字段形状照抄 NapCat 真实的 image 段（它会带 summary / file / url / file_size）。
 */
function privateMessageWithImage(url, { text = '你看这个', summary = '[动画表情]', file = 'AB12CD34.png', fileSize } = {}) {
  const data = { summary, file, url };
  if (fileSize !== undefined) data.file_size = String(fileSize);
  const segments = [{ type: 'image', data }];
  if (text.length > 0) segments.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 100000002,
    sender: { nickname: 'iroha' },
    message: segments,
  };
}

/**
 * 造一条「引用了某条消息」的私聊事件。
 * OneBot v11 的 `reply` 段里只有被引用消息的 message_id —— 图与正文都不在里面，
 * 这正是要额外走一趟 `get_msg` 的原因。
 */
function privateMessageWithReply(text, quotedId) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 100000002,
    sender: { nickname: 'iroha' },
    message: [
      { type: 'reply', data: { id: quotedId } },
      { type: 'text', data: { text } },
    ],
  };
}

/** 造一条群聊入站事件；`messageId` 用于验证引用回复。 */
function groupMessage(segments, { userId = 100000003, name = 'tomori', card = 'kaguya', messageId = 7000 } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 100000001,
    user_id: userId,
    message_id: messageId,
    sender: { nickname: name, card },
    message: segments,
  };
}

/** 「有人 @ 了机器人并说了这句话」。 */
function mention(text, options) {
  return groupMessage([{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'text', data: { text } }], options);
}

/** 模拟 Harness 跑完一轮：认领最新一条入站消息 → 产出 assistant 文本 → turn 结束。 */
function completeTurn(host, agent, text, turn = 1) {
  const session = { id: agent.id };
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[agent.inbox.length - 1], turn });
  host.list.emit('session/event', session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  });
  host.list.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  return session;
}

/**
 * 取某个会话已发出的所有消息正文。
 */
function sentTexts(onebot, action = 'send_group_msg') {
  return onebot.calls.filter((call) => call.action === action).map((call) => call.params.message);
}

/**
 * 造一个假的「python 解释器」：一个可执行的 shell 脚本，按 jm_download.py 的
 * JSON Lines 协议说话，并真的在 `--out` 目录里落一个 PDF。
 *
 * 为什么要连进程一起测：spawn / 超时 / 并发键 / 文件服务这些才是这条链路上最容易
 * 出错的地方，只有把假脚本真的 spawn 起来才验证得到。
 *
 * @param dir - 放脚本的目录（会作为插件的 cwd）。
 * @param options.body - `'ok'` = 正常下载；`'fail'` = 回一个失败结果；其余字符串当作错误信息。
 * @param options.delayMs - 脚本先睡多久（用来验证「同一个会话不能并发下载」）。
 * @returns 脚本的绝对路径。
 */
async function writeFakeJmPython(dir, { body = 'ok', delayMs = 0 } = {}) {
  const path = join(dir, 'fake-jm-python.sh');
  const lines = [
    '#!/bin/sh',
    'out=""',
    'while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done',
  ];
  if (delayMs > 0) lines.push(`sleep ${(delayMs / 1000).toFixed(1)}`);
  if (body === 'ok') {
    lines.push(`echo '{"event":"meta","id":"422866","title":"Test Book","author":"tester","chapters":2,"pages":3}'`);
    lines.push('printf "%s" "%PDF-1.4 fake" > "$out/Test Book.pdf"');
    lines.push(
      `echo '{"event":"result","ok":true,"pdf":"'"$out"'/Test Book.pdf","pages":3,"bytes":13,"title":"Test Book","kind":"album","chapters":2}'`,
    );
  } else {
    lines.push(`echo '{"event":"result","ok":false,"error":"${body === 'fail' ? '本子不存在' : body}"}'`);
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

/**
 * 起一个开了禁漫下载的插件实例：cwd 是新的临时目录（PDF 就落在里面），
 * `jmPython` 指向假脚本，文件服务绑 127.0.0.1（测试里没有 docker 网桥）。
 */
async function bootJm(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-jm-'));
  const python = await writeFakeJmPython(cwd, config.__python ?? {});
  const { __python, ...rest } = config;
  const booted = await boot(
    { cwd, jmDir: '.qq-jm', jmPython: python, jmFileHost: '127.0.0.1', ...rest },
    hostOptions,
    onebotOptions,
  );
  return { ...booted, cwd, python };
}

/**
 * 所有起过的插件实例：用例结束时统一收尾。
 *
 * 插件会持有 OneBot socket（以及禁漫下载的、给 NapCat 取文件的 HTTP 服务），
 * 测试里没人卸载插件，这些监听中的句柄会让**测试进程**一直不退出 —— 所以这里
 * 统一在 `after` 里把每个实例的 `ctx.effect` 销毁回调跑一遍、关掉假服务端。
 */
const liveBoots = [];

after(async () => {
  for (const instance of liveBoots.splice(0)) {
    instance.host.list.stop?.();
    await instance.onebot.close().catch(() => {});
  }
});

/**
 * 起一个插件实例：接上全新的假 OneBot 服务端、假 Host 与临时会话根目录，并等它完成身份识别。
 * @param config - 插件配置（会与下面的测试默认值合并）。
 * @param hostOptions - 假 Host 的选项（工具表、预设平面…）。
 * @param onebotOptions - 假 OneBot 服务端的选项（例如 `get_image` 的桩）。
 */
async function boot(config = {}, hostOptions = {}, onebotOptions = {}) {
  const onebot = await startFakeOneBot(onebotOptions);
  // 每个用例一个独立的临时会话根目录：/reset 只可能碰到这里面的东西，
  // 绝不会扫到真实的 ~/.dsh/sessions。
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'qq-bridge-test-'));
  const host = makeHost({ sessionsRoot, ...hostOptions });
  // 用 Config() 过一遍真实 schema，测试里传的配置因此也顺带验证了默认值合并。
  // 延迟一律压到 0：拟人节奏不该让测试多等几秒，需要验证时序的用例自己覆盖。
  // 攒批窗口同理：默认关掉，要验证「几个人同时 @ 只回一轮」的用例自己给一个小窗口。
  apply(host.ctx, Config({ endpoint: onebot.endpoint, cwd: '/tmp', readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, batchWindowMs: 0, ...config }));
  // 先登记再启动：`start()` 跑的是 `ctx.effect` 的回调（OneBot 连接、摘要与主动说话的
  // 定时器），它可能抛错 —— 例如插件漏声明 inject 时的 cordis 检查。抛错时这个实例也
  // 必须进收尾清单，否则刚起的假 OneBot 服务端会一直挂着监听，让整个测试文件停不下来
  // （node 的 test runner 会等到事件循环空掉）。这类失败要「红得快且干净」。
  const instance = { onebot, host, sessionsRoot, cwd: config.cwd ?? '/tmp' };
  liveBoots.push(instance);
  host.list.start();
  // 等到 get_login_info 发出，说明 socket 已就绪、selfId 即将可用。
  await until(() => onebot.calls.some((call) => call.action === 'get_login_info'), 'the plugin to identify itself');
  await waitForSelfId(host);
  return instance;
}

/**
 * 等到插件真的知道自己是谁（`selfId` 就绪）。
 *
 * 不能只等 `get_login_info` 这个**请求**被服务端收到：客户端是在 open 时先报
 * `connected`、随后才发起登录查询并在**响应**回来时写入 selfId 的，所以那一刻
 * selfId 还是空串，此时投递的事件会被 `admit()` 按「自己发的消息」直接丢掉。
 * 这里用插件自己的 qq_list_conversations 工具做就绪探测，得到确定性的时序。
 */
async function waitForSelfId(host, timeoutMs = 5000) {
  const tool = host.tools.get('qq_list_conversations');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await tool.execute({}, {});
    if (value.self_id === String(SELF_ID)) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the OneBot client to learn its own id');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 用例一：私聊消息 → Agent turn → 回复回到 QQ。
test('a private message becomes an Agent turn whose reply returns to QQ', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'text', data: { text: '你好' } }],
    });

    // 等到消息真的投进 Agent 的收件箱，而不是「Agent 对象刚被造出来」：create() 里还有
    // 落盘会话记录的异步步骤，只看 created[0] 会在它写盘的那一刻就抢先断言（偶发失败）。
    const agent = await until(
      () => (host.list.created[0]?.inbox.length === 1 ? host.list.created[0] : undefined),
      'the private message to reach the Agent',
    );
    assert.deepEqual(agent.options, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
    assert.equal(agent.inbox.length, 1);
    assert.equal(agent.inbox[0].content[0].text, '你好');
    assert.equal(agent.inbox[0].role, 'user');
    assert.equal(agent.inbox[0].source.kind, 'user');

    // QQ 渠道提示小节必须注册在该 Agent 自己的作用域上。
    assert.ok(host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel'));
    const modelVariable = host.list.prompts.find((entry) => entry.kind === 'variable' && entry.name === 'model');
    assert.equal(modelVariable.provider(), 'deepseek-flash');

    // 下面模拟 Harness：认领这条消息（开启 turn），再产出最终的 assistant 消息。
    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先看看' }, { type: 'text', text: '你好呀，很高兴认识你' }] } },
    });
    // 不属于本插件的会话事件绝不能被转发出去（防止串台）。
    host.list.emit('session/event', { id: 'some-other-session' }, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'unrelated' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    const sent = await until(
      () => (sentTexts(onebot, 'send_private_msg').length === 2 ? sentTexts(onebot, 'send_private_msg') : undefined),
      'the reply to reach QQ',
    );
    assert.equal(onebot.calls.find((call) => call.action === 'send_private_msg').params.user_id, '100000002');
    // 多条 assistant 文本在同一个 turn 内累积（用换行连接）；humanize 下换行 = 分条，
    // 所以这是两条独立的消息，而不是一条消息里换行。
    assert.deepEqual(sent, ['我先看看', '你好呀，很高兴认识你']);
  } finally {
    await onebot.close();
  }
});

// 用例二：群消息只有在 @ 机器人时才会送到 Agent。
test('a group message only reaches the Agent when the bot is mentioned', async () => {
  const { onebot, host } = await boot();
  const group = (segments) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: 100000001,
    user_id: 100000003,
    sender: { nickname: 'tomori', card: 'kaguya' },
    message: segments,
  });
  try {
    // 没有 @ 时，消息应被完全忽略（不创建任何会话）。
    onebot.push(group([{ type: 'text', data: { text: '随便聊聊' } }]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.list.created.length, 0);

    // `@bot你好` 必须只去掉 @ 段，而不能连带吃掉后面的问候语。
    onebot.push(group([{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'text', data: { text: '你好' } }]));
    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    assert.equal(agent.inbox[0].content[0].text, '你好');
    // 渠道提示里应带上群号，让 Agent 知道自己在哪个群说话。
    assert.ok(promptText(host, 'qq-bridge:channel').includes('100000001'));

    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    // 群聊走 send_group_msg，且带的是 group_id。
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the group reply');
    assert.equal(sent.params.group_id, '100000001');
    assert.equal(sent.params.message, '在的');
  } finally {
    await onebot.close();
  }
});

// 用例：群里几个人几乎同时 @ 机器人 —— 攒成一条 user message，只回一轮。
test('mentions that land together become one turn instead of one reply each', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400 });
  try {
    onebot.push(mention('你俩在吗', { userId: 100000003, name: 'tomori', card: 'kaguya', messageId: 7001 }));
    onebot.push(mention('帮我看看这个', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 7002 }));
    onebot.push(mention('我也想问', { userId: 4444444444, name: 'mutsumi', card: 'mutsumi', messageId: 7003 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    // 三句话 = 一条消息 = 一次 followup = 一轮 = 一条回复。
    assert.equal(agent.inbox.length, 1);
    const text = agent.inbox[0].content[0].text;
    assert.ok(text.includes('kaguya: 你俩在吗'), text);
    assert.ok(text.includes('iroha: 帮我看看这个'), text);
    assert.ok(text.includes('mutsumi: 我也想问'), text);

    // 提示词里说的是「几个人一起在跟你说话」，而不是只报最后一个。
    const prompt = promptText(host, 'qq-bridge:channel');
    assert.ok(prompt.includes('kaguya（QQ 100000003）'), prompt);
    assert.ok(prompt.includes('mutsumi（QQ 4444444444）'), prompt);

    completeTurn(host, agent, '都在呢', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the single reply');
    assert.equal(sent, '都在呢');
    // 再等一会儿：三个人不该被分别答复一遍。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(sentTexts(onebot), ['都在呢']);
  } finally {
    await onebot.close();
  }
});

// 用例：同一个人连发几句也只回一轮，而且指向他最后那条。
test('a run of messages from one person is one turn that quotes the last of them', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 7101 }));
    onebot.push(mention('帮我看看这个报错', { messageId: 7102 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    assert.equal(agent.inbox.length, 1);
    assert.ok(agent.inbox[0].content[0].text.includes('连着发的'), agent.inbox[0].content[0].text);

    completeTurn(host, agent, '嗯', 1);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the reply');
    assert.deepEqual(sent.params.message, [
      { type: 'reply', data: { id: '7102' } },
      { type: 'text', data: { text: '嗯' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例：一批里有好几个人时，回复不指向其中任何一个人 —— 引用谁都像是在单独回他。
test('a batch from several people is not pinned to any one of them', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 150, batchMaxWaitMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { userId: 100000003, messageId: 7201 }));
    onebot.push(mention('帮我看看这个', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 7202 }));

    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length > 0, 'the batched message to reach the Agent');
    completeTurn(host, agent, '都在呢', 1);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the reply');
    assert.equal(sent.params.message, '都在呢');
  } finally {
    await onebot.close();
  }
});

// 用例：batchWindowMs: 0 回到「来一条回一条」。
test('batchWindowMs: 0 goes back to one turn per message', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 0 });
  try {
    onebot.push(mention('第一句', { messageId: 7301 }));
    onebot.push(mention('第二句', { messageId: 7302 }));
    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length === 2, 'both messages to reach the Agent separately');
    assert.equal(agent.inbox[0].content[0].text, '第一句');
    assert.equal(agent.inbox[1].content[0].text, '第二句');
  } finally {
    await onebot.close();
  }
});

// 用例：群里一直有人 @ 也不能让机器人永远不吭声 —— 一批的等待以第一条为起点卡上限。
test('the batch wait is capped even while people keep talking', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 300, batchMaxWaitMs: 600 });
  let chatter;
  try {
    const started = Date.now();
    // 不 await：一边不停地有人说话，一边看它会不会按上限把这一批发出去。
    // 没有上限的话，要等最后一句之后再过一整个窗口才轮到机器人开口（≈ 1500ms）。
    chatter = (async () => {
      for (let i = 0; i < 12; i += 1) {
        onebot.push(mention(`第 ${i} 句`, { messageId: 7400 + i }));
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();
    const agent = await until(() => host.list.created[0], 'the capped batch to flush', 3000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `the batch should flush at the cap (~600ms), took ${elapsed}ms`);
    await until(() => agent.inbox.length > 0, 'the batched messages to reach the Agent');
    assert.ok(agent.inbox.length < 12, `the batch must not wait for the chatter to stop (${agent.inbox.length} messages)`);
  } finally {
    await chatter?.catch(() => {});
    await onebot.close();
  }
});

// 用例：/reset 之前攒着的那批话要先投出去 —— 它们是清空前说的，不能被一起忘掉。
test('the reset command delivers a pending batch before it wipes the conversation', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 200, batchMaxWaitMs: 400 });
  try {
    onebot.push(privateMessage('你好'));
    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已清空')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');
    // 攒着的那条消息在清空之前投了出去，Agent 随后才被销毁。
    const first = host.list.created[0];
    assert.ok(first, 'the pending batch should reach the Agent before the reset');
    assert.equal(first.inbox[0].content[0].text, '你好');
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
  } finally {
    await onebot.close();
  }
});

// 用例：攒批窗口的默认值是可以直接用的「人味」节奏，也可以关掉。
test('the batch window defaults to a human beat and can be turned off', () => {
  assert.equal(Config({}).batchWindowMs, 1200);
  assert.equal(Config({}).batchMaxWaitMs, 5000);
  assert.equal(Config({ batchWindowMs: 0 }).batchWindowMs, 0);
});

// 用例三：白名单、未开启的渠道、以及消息发送者是机器人自己 —— 都应被丢弃。
test('whitelists, disabled channels, and self-messages are dropped', async () => {
  const { onebot, host } = await boot({ allowUsers: ['111'], privateChat: false });
  try {
    // 私聊已被 privateChat: false 关闭，且该用户也不在白名单里，应被丢弃。
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'text', data: { text: '你好' } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
  }
});

// 用例四：模型路由 —— 配置显式指定时用配置，否则继承部署默认选择。
test('the QQ agent model is configurable and defaults to the deployment selection', async () => {
  const { onebot, host } = await boot({ provider: 'custom', model: 'my-model' });
  try {
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000003,
      sender: { nickname: 'tomori' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    });
    const agent = await until(() => host.list.created[0], 'the Agent to be created');
    // provider/model 都配置了，因此不继承默认的 reasoningEffort。
    assert.deepEqual(agent.options, { provider: 'custom', model: 'my-model' });
  } finally {
    await onebot.close();
  }
});

// 用例五：出站工具能把消息发到指定群，并在返回值里回显目标。
test('the outbound tool sends to a group and reports the target', async () => {
  const { onebot, host } = await boot();
  try {
    const tool = host.tools.get('qq_send_message');
    const value = await tool.execute({ target_type: 'group', target_id: '100000001', message: '大家好' }, {});
    assert.deepEqual(value, { target_type: 'group', target_id: '100000001', parts: 1 });
    const sent = onebot.calls.find((call) => call.action === 'send_group_msg');
    assert.equal(sent.params.message, '大家好');
  } finally {
    await onebot.close();
  }
});

// 用例六：超长回复按配置的上限自动分段（这里把上限压到 20 字符便于验证）。
test('a long reply is split at the configured limit', async () => {
  const { onebot, host } = await boot({ maxReplyChars: 20 });
  try {
    const tool = host.tools.get('qq_send_message');
    // 三段各 15 字符 + 空格分隔，总长超过 20，必然被切成 3 段。
    const text = `${'a'.repeat(15)} ${'b'.repeat(15)} ${'c'.repeat(15)}`;
    const value = await tool.execute({ target_type: 'private', target_id: '100000002', message: text }, {});
    assert.equal(value.parts, 3);
    const sent = onebot.calls.filter((call) => call.action === 'send_private_msg');
    assert.equal(sent.length, 3);
    // 每段都不能超过上限。
    assert.ok(sent.every((call) => call.params.message.length <= 20));
  } finally {
    await onebot.close();
  }
});

// 用例八：allowTools 把 QQ 会话 Agent 收窄到白名单内，留空则完全不限制。
test('allowTools restricts the QQ agent to the configured tools', async () => {
  // 留空（默认）：不施加任何限制，行为与未引入该配置时一致。
  const plain = await boot();
  try {
    plain.onebot.push(privateMessage('你好'));
    await until(() => plain.host.list.created[0], 'the unrestricted Agent');
    assert.deepEqual(plain.host.list.restrictions, []);
    const section = promptText(plain.host, 'qq-bridge:channel');
    assert.ok(section.includes('qq_send_message / qq_list_conversations'));
  } finally {
    await plain.onebot.close();
  }

  // 非空：只放开列出的工具，且收窄发生在该 Agent 自己的作用域上。
  const restricted = await boot({ allowTools: ['read', 'qq_send_message'] });
  try {
    restricted.onebot.push(privateMessage('你好'));
    const agent = await until(() => restricted.host.list.created[0], 'the restricted Agent');
    assert.deepEqual(restricted.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: ['read', 'qq_send_message'] } }]);
    // 消息照常投递：收窄工具不影响对话链路本身。
    assert.equal(agent.inbox.length, 1);
    // 没被放开的 qq_list_conversations 不能再出现在渠道提示里。
    const section = promptText(restricted.host, 'qq-bridge:channel');
    assert.ok(section.includes('qq_send_message'));
    assert.ok(!section.includes('qq_list_conversations'));
  } finally {
    await restricted.onebot.close();
  }
});

// 用例九：白名单里写了不存在的工具名时退化处理 —— 丢掉不认识的名字并告警；
// 一个都不剩时把工具全部收走（fail-closed），而不是让整条回复链路失效。
test('unknown names in allowTools degrade instead of breaking the conversation', async () => {
  const partial = await boot({ allowTools: ['read', 'no_such_tool'] });
  try {
    partial.onebot.push(privateMessage('你好'));
    const agent = await until(() => partial.host.list.created[0], 'the Agent');
    assert.deepEqual(partial.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: ['read'] } }]);
    assert.ok(partial.host.list.warnings.some((line) => line.includes('no_such_tool')));
  } finally {
    await partial.onebot.close();
  }

  // 全部写错：等价于禁止一切工具，但会话本身仍然活着（能收消息）。
  const broken = await boot({ allowTools: ['nope_a', 'nope_b'] });
  try {
    broken.onebot.push(privateMessage('你好'));
    const agent = await until(() => broken.host.list.created[0], 'the Agent');
    assert.deepEqual(broken.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: [] } }]);
    assert.equal(agent.inbox.length, 1);
  } finally {
    await broken.onebot.close();
  }
});

// 用例十二：Web 表面（dsh-web-app）把 bash / fs / web 这些「agent 平面」的工具从
// 宿主搬进了 Agent 预设。插件必须让 QQ Agent join 一个预设，否则白名单里的
// read / web_search 全是「不存在的工具」—— 表现就是「QQ 会话没有联网能力」。
test('the QQ agent joins an agent preset, so preset-plane tools exist for the whitelist', async () => {
  const presets = {
    default: 'standard',
    compositions: {
      standard: ['bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'],
    },
  };
  const allowTools = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'qq_send_message', 'qq_list_conversations'];

  const { onebot, host } = await boot({ allowTools }, { presets });
  try {
    onebot.push(privateMessage('帮我查一下今天的新闻'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    // 加入的是部署的默认预设，并且写进了会话 header 的 agentPreset。
    assert.deepEqual(host.list.mountedPresets, ['standard']);
    assert.deepEqual(host.list.metas, [{ sessionId: agent.id, meta: { cwd: '/tmp', agentPreset: 'standard' } }]);
    // 预设里的工具 join 之后才存在，白名单因此**完整**生效，而不是退化成「只剩 qq_*」。
    assert.deepEqual(host.list.restrictions, [{ sessionId: agent.id, filter: { allow: allowTools } }]);
    assert.equal(
      host.list.warnings.some((line) => line.includes('allowTools rejected')),
      false,
    );
  } finally {
    await onebot.close();
  }

  // 对照组：没有预设平面时（headless 组合就是这样），同样的白名单只能留住
  // 宿主平面真实存在的工具 —— 这正是线上「没有联网能力」的成因。
  const bare = await boot({ allowTools }, { knownTools: ['qq_send_message', 'qq_list_conversations'] });
  try {
    bare.onebot.push(privateMessage('帮我查一下今天的新闻'));
    const agent = await until(() => bare.host.list.created[0], 'the Agent');
    assert.deepEqual(bare.host.list.mountedPresets, []);
    assert.deepEqual(bare.host.list.restrictions, [
      { sessionId: agent.id, filter: { allow: ['qq_send_message', 'qq_list_conversations'] } },
    ]);
    assert.ok(bare.host.list.warnings.some((line) => line.includes('a whitelist cannot grant tools this Agent does not have')));
  } finally {
    await bare.onebot.close();
  }
});

// 用例十三：agentPreset 的两种显式取值 —— 指定名字、以及 none（不挂预设）。
test('agentPreset selects the mount explicitly and none skips it', async () => {
  const presets = {
    default: 'standard',
    compositions: { minimal: ['bash'], standard: ['read', 'web_search'] },
  };

  // 这里把宿主平面收成只有 qq_*，好让「minimal 里没有 read」这件事看得清楚。
  const chosen = await boot(
    { agentPreset: 'minimal', allowTools: ['read'] },
    { presets, knownTools: ['qq_send_message', 'qq_list_conversations'] },
  );
  try {
    chosen.onebot.push(privateMessage('你好'));
    const agent = await until(() => chosen.host.list.created[0], 'the Agent');
    assert.deepEqual(chosen.host.list.mountedPresets, ['minimal']);
    assert.equal(chosen.host.list.metas[0].meta.agentPreset, 'minimal');
    // join 的预设里没有 read：白名单给不出这个 Agent 没有的能力，只保留真正存在的名字。
    assert.deepEqual(chosen.host.list.restrictions, [{ sessionId: agent.id, filter: { allow: [] } }]);
  } finally {
    await chosen.onebot.close();
  }

  const skipped = await boot({ agentPreset: 'none' }, { presets });
  try {
    skipped.onebot.push(privateMessage('你好'));
    await until(() => skipped.host.list.created[0], 'the Agent');
    assert.deepEqual(skipped.host.list.mountedPresets, []);
    // 不挂预设就没有 agentPreset 字段，会话按「无预设」记录。
    assert.deepEqual(skipped.host.list.metas[0].meta, { cwd: '/tmp' });
  } finally {
    await skipped.onebot.close();
  }

  // 预设名写错：告警但不打死链路，消息照常投递。
  const broken = await boot({ agentPreset: 'no_such_preset' }, { presets });
  try {
    broken.onebot.push(privateMessage('你好'));
    const agent = await until(() => broken.host.list.created[0], 'the Agent');
    assert.deepEqual(broken.host.list.mountedPresets, []);
    assert.ok(broken.host.list.warnings.some((line) => line.includes('no_such_preset')));
    assert.equal(agent.inbox.length, 1);
  } finally {
    await broken.onebot.close();
  }
});

// 用例十四：bundle 自带的 qq 预设必须**自己就是收窄的**。
//
// 起因：standard 预设的 subagent 行开了 `modelSelectionSettings`，这个模式下
// dsh-tool-subagent 会在每个 Agent 创建时通过 `agent.ctx` 在 **Agent 自己的作用域**
// 里再注册一份工具；而 `tools.restrict()` 按设计只收窄「继承来的」工具，
// 于是 subagent 会绕过 allowTools 出现在 QQ 会话的工具表里。
// 所以：配置里的 agentPreset 必须指向本 bundle 声明的、不含任何 delegation 行的预设，
// 且 allowTools 里每个名字都要在该预设里有出处。
test('the bundled patch declares the narrowed preset the plugin mounts', async () => {
  // Loader 的 `!!js` 标签（`!!js <expression>`）不在标准 schema 里：注册成普通标量，
  // 本用例只关心结构，不关心那些表达式怎么求值。
  const jsExpression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => data });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsExpression]);
  const doc = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema });
  const rows = doc.flatMap((entry) => entry.insert ?? []);
  const bridge = rows.find((row) => row.name === '@qqbot/dsh-plugin-qq');
  assert.ok(bridge, 'the bridge row must exist in cordis.patch.yml');

  const wanted = bridge.config.agentPreset;
  const preset = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-preset' && row.config.id === wanted);
  assert.ok(preset, `agentPreset "${wanted}" must be declared in the same patch file`);

  const names = preset.config.plugins.map((row) => row.name);
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'));
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs-search'));
  assert.ok(names.includes('@deepseek-ai/dsh-tool-web'));

  // 会「在 Agent 自己作用域里注册工具」或本身就该留在白名单外的行，一个都不能有。
  const forbidden = [
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-ralph',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
  ];
  for (const name of forbidden) assert.ok(!names.includes(name), `${name} must not be in the QQ preset`);

  // 本地 skill 平面：dsh-web-app 把宿主的 skill-filesystem / tool-skill 停掉了
  // （「presets own local discovery」），所以预设里必须自己挂一份，否则
  // `<项目根>/.dsh/skills` 下的 skill 对 QQ 会话根本不存在。
  assert.ok(names.includes('@deepseek-ai/dsh-skill-filesystem'), 'the QQ preset must provide local skill discovery');
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), 'the QQ preset must provide the skill tool');

  // 白名单只能收窄、不能授予：每个放开的工具名都要能在这个预设里找到出处。
  // 本插件的工具是**宿主平面**的全局工具（不在预设里），所以直接算作出处：
  //   - qq_send_* / qq_jm_pdf：一直注册；
  //   - qq_transcript / qq_memory：memory 开着时才注册；
  //   - skill：由预设里的 tool-skill 提供。
  const provided = new Set(['qq_send_message', 'qq_send_image', 'qq_list_conversations', 'qq_jm_pdf', 'skill']);
  if (bridge.config.memory !== false) for (const name of ['qq_transcript', 'qq_memory']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-fs')) for (const name of ['read', 'read_image', 'write', 'edit']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-fs-search')) for (const name of ['glob', 'grep']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-web')) for (const name of ['web_search', 'web_fetch']) provided.add(name);
  if (names.includes('@deepseek-ai/dsh-tool-skill')) provided.add('skill');
  for (const name of bridge.config.allowTools) {
    assert.ok(provided.has(name), `allowTools entry "${name}" has no provider in the QQ preset`);
  }
  // write / edit 由 tool-fs 提供，但必须在白名单之外（QQ 那头是只读的）。
  assert.ok(!bridge.config.allowTools.includes('write'));
  assert.ok(!bridge.config.allowTools.includes('edit'));
});

// 用例十五：插件日志必须真的能进 journal。
//
// 本部署没有把 cordis 的 logger 接到 stdout/stderr 上（实测 `ctx.logger.warn` 只进
// 内存缓冲与 OTel），而 operator 排查「QQ 会话怎么没能力了」只能靠 journalctl ——
// 所以真实宿主里插件会把每条日志再镜像一行到 stderr。这里把这条行为钉住，
// 免得有人「顺手」把 stderr 那一份删掉。
test('plugin logs are mirrored to stderr in a real host', async () => {
  const capture = async (hostOptions) => {
    const lines = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      const booted = await boot({}, hostOptions);
      try {
        booted.onebot.push(privateMessage('你好'));
        await until(() => booted.host.list.created[0], 'the Agent');
      } finally {
        await booted.onebot.close();
      }
    } finally {
      process.stderr.write = original;
    }
    // 只挑本插件每次创建 Agent 必打的那条：先前用例留下的客户端会不定期
    // 重连并打日志，不能对其他行做断言。
    return lines.filter((line) => line.startsWith('qq-bridge: ') && line.includes('created efefff51'));
  };

  // 真实宿主的 logger 门面带 exporter() -> 镜像。
  assert.equal((await capture({ loggerExporter: true })).length, 1);
  // 测试用的普通日志桩没有 -> 不镜像（同时让测试输出保持干净）。
  assert.deepEqual(await capture({}), []);
});

// 用例十：/reset 清空当前会话 —— 销毁活着的 Agent、删掉磁盘记录，且指令本身
// 不会被投递给 Agent；之后再来一条消息必须是全新的 Agent（旧记忆不回流）。
test('the reset command clears the conversation it was sent from', async () => {
  const { onebot, host, sessionsRoot } = await boot();
  try {
    onebot.push(privateMessage('你好'));
    const first = await until(() => host.list.created[0], 'the Agent to be created');
    // 假后端在 create 时已落地磁盘记录，先确认它存在。
    const storedDir = join(sessionsRoot, '--fake-project--', first.id);
    assert.ok(existsSync(storedDir));

    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已清空')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');

    // Agent 被销毁、磁盘记录被删除。
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
    assert.equal(existsSync(storedDir), false);
    // 指令没有进 Agent 的收件箱（只有最开始那条「你好」）。
    assert.equal(first.inbox.length, 1);

    // 再来一条消息：必须是新的 Agent（新对象），证明记忆没有回流。
    onebot.push(privateMessage('还记得我刚才说什么吗'));
    const second = await until(() => host.list.created[1], 'a fresh Agent after the reset');
    assert.notEqual(second, first);
    assert.equal(second.inbox.length, 1);
    assert.equal(second.inbox[0].content[0].text, '还记得我刚才说什么吗');
  } finally {
    await onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

// 用例十一：resetCommand 留空即禁用；此时 /reset 只是一句普通消息。
test('an empty resetCommand disables the reset handling', async () => {
  const { onebot, host } = await boot({ resetCommand: '' });
  try {
    onebot.push(privateMessage('/reset'));
    const agent = await until(() => host.list.created[0], 'the Agent to be created');
    assert.equal(agent.inbox.length, 1);
    assert.equal(agent.inbox[0].content[0].text, '/reset');
    assert.deepEqual(host.list.disposed, []);
    // 没有任何「已清空」的回复发出。
    assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false);
  } finally {
    await onebot.close();
  }
});

// 用例七：会话列表工具能报告实时连接状态、模型路由与在线群列表。
test('the conversation list tool reports the live QQ route', async () => {
  const { onebot, host } = await boot();
  try {
    const value = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.equal(value.connected, true);
    // self_id 来自真实的 get_login_info 往返，且被统一成字符串。
    assert.equal(value.self_id, String(SELF_ID));
    // source=default 表示模型来自部署默认选择（配置里没填 provider/model）。
    assert.deepEqual(value.route, { provider: 'deepseek-official', model: 'deepseek-flash', source: 'default', error: '' });
    assert.deepEqual(value.groups, [{ id: '100000001', name: '示例群' }]);
  } finally {
    await onebot.close();
  }
});

// ---------------------------------------------------------------------------
// 「像真实的群友」相关行为：群聊上下文、说话节奏、口吻提示、引用回复。
// ---------------------------------------------------------------------------

// 用例十三：没被 @ 的群聊消息不该建 Agent，但应成为下一次回复的上下文。
test('group chatter the bot was not addressed in becomes ambient context', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(groupMessage([{ type: 'text', data: { text: '晚上吃啥' } }], { messageId: 11 }));
    onebot.push(groupMessage([{ type: 'text', data: { text: '随便' } }], { userId: 333, name: 'iroha', card: 'iroha', messageId: 12 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // 只是围观：不该为此创建任何 Agent。
    assert.equal(host.list.created.length, 0);

    onebot.push(mention('你们说呢', { messageId: 13 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const text = promptText(host, 'qq-bridge:channel');
    // 之前的闲聊按「昵称: 内容」出现，模型因此知道大家在聊什么。
    assert.ok(text.includes('kaguya: 晚上吃啥'), text);
    assert.ok(text.includes('iroha: 随便'), text);
    // 被 @ 的那条走 user message，不在环境块里重复一遍。
    assert.ok(!text.includes('你们说呢'));
  } finally {
    await onebot.close();
  }
});

// 用例十四：ambientMessages: 0 时群聊上下文完全不进提示词。
test('ambientMessages: 0 disables the group context', async () => {
  const { onebot, host } = await boot({ ambientMessages: 0 });
  try {
    onebot.push(groupMessage([{ type: 'text', data: { text: '晚上吃啥' } }], { messageId: 11 }));
    onebot.push(mention('你们说呢', { messageId: 12 }));
    await until(() => host.list.created[0], 'the group Agent');
    const text = promptText(host, 'qq-bridge:channel');
    assert.ok(!text.includes('晚上吃啥'));
    // 环境块的表头（「群里最近的消息（旧 → 新；…）」）不该出现。注意别只匹配
    // 「群里最近的消息」这几个字 —— 图片那一条静态说明里也会提到它。
    assert.ok(!text.includes('群里最近的消息（旧 → 新'), text);
  } finally {
    await onebot.close();
  }
});

// ---------------------------------------------------------------------------
// 自动复读：群里连着出现同一条消息（或同一张表情包）时跟着复读，不经过 Agent
// ---------------------------------------------------------------------------

/** 「群里有人发了一条纯文字消息」。 */
function groupText(text, options) {
  return groupMessage([{ type: 'text', data: { text } }], options);
}

/** 等一小会儿，用来断言「这段时间里什么都没发出去」。 */
async function settle(ms = 120) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// 用例：有人接了一句之后，机器人跟着复读 —— 不建会话、不经过模型、不带引用。
test('two identical group messages make the bot repeat along', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 20 }));
    await settle();
    // 只有一条时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupText('6', { userId: 3333333333, name: 'iroha', card: 'iroha', messageId: 21 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeated message'), '6');
    // 复读是插件直接发的纯文本：不带引用/@，也不该为此建一个 Agent 会话。
    const call = onebot.calls.find((item) => item.action === 'send_group_msg');
    assert.equal(call.params.group_id, '100000001');
    assert.equal(call.params.message, '6');
    assert.equal(host.list.created.length, 0);
    const listed = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.deepEqual(listed.sessions, []);
  } finally {
    await onebot.close();
  }
});

// 用例：中间有人说了别的话，前后两条就不算「连着」。
test('a different message in between breaks the repeat chain', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 30 }));
    onebot.push(groupText('草', { userId: 3333333333, card: 'iroha', messageId: 31 }));
    onebot.push(groupText('6', { messageId: 32 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});

// 用例：默认要求至少两个不同的人说过 —— 一个人自己连发两遍是手滑，不是复读。
test('one person sending the same thing twice is not a repeat', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('草', { messageId: 40 }));
    onebot.push(groupText('草', { messageId: 41 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    // 换个人接一句，链已经攒够，立刻跟上。
    onebot.push(groupText('草', { userId: 3333333333, card: 'iroha', messageId: 42 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '草');
  } finally {
    await onebot.close();
  }
});

// 用例：repeatDistinct: false 时，同一个人连发两条也算（想让它更爱复读的一种玩法）。
test('repeatDistinct: false lets one person echo themselves', async () => {
  const { onebot } = await boot({ repeatDistinct: false });
  try {
    onebot.push(groupText('6', { messageId: 50 }));
    onebot.push(groupText('6', { messageId: 51 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6');
  } finally {
    await onebot.close();
  }
});

// 用例：repeatCount 决定「攒几个人」；repeat: false / repeatChance: 0 则完全不跟。
test('repeatCount decides how many echoes are needed, and the switch can turn it off', async () => {
  const three = await boot({ repeatCount: 3 });
  try {
    three.onebot.push(groupText('6', { messageId: 60 }));
    three.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 61 }));
    await settle();
    // 两个人才到一半，还不跟。
    assert.deepEqual(sentTexts(three.onebot), []);
    three.onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 62 }));
    assert.equal(await until(() => sentTexts(three.onebot)[0], 'the third echo to trigger the repeat'), '6');
  } finally {
    await three.onebot.close();
  }

  const off = await boot({ repeat: false });
  try {
    off.onebot.push(groupText('6', { messageId: 63 }));
    off.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 64 }));
    await settle();
    assert.deepEqual(sentTexts(off.onebot), []);
  } finally {
    await off.onebot.close();
  }

  // repeatChance: 0 时一次都不掷中（概率的边界，用确定的方式验证）。
  const shy = await boot({ repeatChance: 0 });
  try {
    shy.onebot.push(groupText('6', { messageId: 65 }));
    shy.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 66 }));
    await settle();
    assert.deepEqual(sentTexts(shy.onebot), []);
  } finally {
    await shy.onebot.close();
  }
});

// 用例：太长的话（一整段）不复读；隔得太久的相同消息也不算「连着」。
test('long messages and far-apart messages are not repeated', async () => {
  const long = await boot({ repeatMaxChars: 10 });
  try {
    const paragraph = '这段话太长了不适合复读';
    long.onebot.push(groupText(paragraph, { messageId: 70 }));
    long.onebot.push(groupText(paragraph, { userId: 3333333333, card: 'iroha', messageId: 71 }));
    await settle();
    assert.deepEqual(sentTexts(long.onebot), []);
  } finally {
    await long.onebot.close();
  }

  const stale = await boot({ repeatWindowMs: 40 });
  try {
    stale.onebot.push(groupText('6', { messageId: 72 }));
    await settle(120);
    stale.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 73 }));
    await settle();
    assert.deepEqual(sentTexts(stale.onebot), []);
  } finally {
    await stale.onebot.close();
  }

  // repeatWindowMs: 0 = 不限间隔：隔一会儿再说同一句照样算。
  const unlimited = await boot({ repeatWindowMs: 0 });
  try {
    unlimited.onebot.push(groupText('6', { messageId: 74 }));
    await settle(120);
    unlimited.onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 75 }));
    assert.equal(await until(() => sentTexts(unlimited.onebot)[0], 'the repeat with no window'), '6');
  } finally {
    await unlimited.onebot.close();
  }
});

// 用例：图、表情、@ 别人的消息都不复读 —— 复读出去只会变成占位符或再 @ 人家一次。
// 用例：取不到字节的图（URL 过期、实现不给可下载地址、下载关着）不复读 —— 判「是不是同一张」
// 只能靠内容哈希，拿不到字节就别猜；顺带确认这种图也不会把消息链路弄坏。
test('images that cannot be downloaded are never repeated', async () => {
  const { onebot } = await boot();
  try {
    const dead = (messageId, userId, card) => groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'x.gif', url: '' } }], { messageId, userId, card });
    onebot.push(dead(210, 100000003, 'kaguya'));
    onebot.push(dead(211, 3333333333, 'iroha'));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});

// 用例：跟过一句就断链 —— 群里一直刷同一个字时，它不会一句不落地跟着刷。
test('the bot repeats once and then waits for a fresh pair', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 90 }));
    onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 91 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6');

    // 第三条相同的消息不该立刻再跟一次（链已经断了）。
    onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 92 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), ['6']);

    // 再来一条相同的消息才又攒够一对。
    onebot.push(groupText('6', { userId: 5555555555, name: '路人', card: '路人', messageId: 93 }));
    await until(() => sentTexts(onebot).length === 2, 'the second repeat');
    assert.deepEqual(sentTexts(onebot), ['6', '6']);
  } finally {
    await onebot.close();
  }
});

// 用例：@ 机器人的那条走 Agent 回答，不会被顺带复读一遍（它同时也打断复读链）。
test('messages addressed to the bot are answered instead of echoed', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('你好', { messageId: 100 }));
    onebot.push(mention('你好', { userId: 3333333333, card: 'iroha', messageId: 101 }));
    await until(() => host.list.created[0], 'the group Agent');
    await settle();
    assert.deepEqual(sentTexts(onebot), []);

    // 两条 @ 打断了链：接下来要说两句一样的，才会被跟。
    onebot.push(groupText('你好', { messageId: 102 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    onebot.push(groupText('你好', { userId: 3333333333, card: 'iroha', messageId: 103 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '你好');
  } finally {
    await onebot.close();
  }
});

// 用例：groupTrigger: all 时每条都算被 @，复读没有插话的余地（它本来就在逐条回话）。
test('groupTrigger: all leaves no room for an echo', async () => {
  const { onebot, host } = await boot({ groupTrigger: 'all' });
  try {
    onebot.push(groupText('6', { messageId: 104 }));
    onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 105 }));
    await until(() => host.list.created[0], 'the group Agent');
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});

// 用例：复读只在允许的群里发生；私聊里连发两条一样的不跟。
test('the echo stays inside allowed groups and out of private chat', async () => {
  const { onebot } = await boot({ allowGroups: ['100000001'] });
  try {
    const other = (messageId, userId) => ({
      post_type: 'message',
      message_type: 'group',
      group_id: 555555555,
      user_id: userId,
      message_id: messageId,
      sender: { nickname: '路人' },
      message: [{ type: 'text', data: { text: '6' } }],
    });
    onebot.push(other(110, 10001));
    onebot.push(other(111, 10002));
    onebot.push(privateMessage('6'));
    onebot.push(privateMessage('6'));
    await settle();
    assert.deepEqual(sentTexts(onebot), []);
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), []);
  } finally {
    await onebot.close();
  }
});

// 用例：只有空白不同（换行、多个空格）的相同正文照样算复读，发出去的是后一条的原文。
test('whitespace-only differences still count, and the later wording is what goes out', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('  6 6  ', { messageId: 120 }));
    onebot.push(groupText('6  6\n', { userId: 3333333333, card: 'iroha', messageId: 121 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6  6');
  } finally {
    await onebot.close();
  }
});

// 用例：复读是**原样文字**，正文里的 `[[图片: …]]` 标记不会被当成发文件的指令。
test('a repeated line is never parsed as a sticker marker', async () => {
  const { onebot } = await boot();
  try {
    const line = '[[图片: .qq-stickers/笑死.gif]]';
    onebot.push(groupText(line, { messageId: 130 }));
    onebot.push(groupText(line, { userId: 3333333333, card: 'iroha', messageId: 131 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), line);
    // 群里人打的是字，不是指令：发出去的必须是同样一行字，而不是一张图。
    assert.equal(typeof onebot.calls.find((item) => item.action === 'send_group_msg').params.message, 'string');
  } finally {
    await onebot.close();
  }
});

// ---------------------------------------------------------------------------
// 表情包复读：连着两张一样的表情包/图片，就跟着把这张发回去
// ---------------------------------------------------------------------------

/** 「群里有人只发了一张图」。 */
function groupSticker(url, { messageId = 7000, userId = 100000003, card = 'kaguya', summary = '[动画表情]', file = 'A.png' } = {}) {
  return groupMessage([{ type: 'image', data: { summary, file, url } }], { messageId, userId, card });
}

/** 从一条出站消息里取出图片字节（`base64://` 解回来）。 */
function sentImageBytes(call) {
  assert.equal(call.params.message[0].type, 'image');
  return Buffer.from(call.params.message[0].data.file.replace('base64://', ''), 'base64');
}

// 用例：同一张表情包连着出现两次 —— 跟着把那张发回去；不建会话，也不多花带宽。
test('two identical stickers in a row get echoed', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 140 }));
    await settle();
    // 只有一张时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupSticker(images.url(), { messageId: 141, userId: 3333333333, card: 'iroha' }));
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message)),
      'the repeated sticker',
    );
    assert.equal(sent.params.group_id, '100000001');
    assert.equal(sent.params.message.length, 1);
    assert.deepEqual(sentImageBytes(sent), TINY_PNG);
    // 复读是插件直接发的：不建会话、不经过模型。
    assert.equal(host.list.created.length, 0);
    // 判「是不是同一张」要内容哈希，而这份字节就是环境上下文落盘时留下的：
    // 两条消息 = 两次下载（`mediaFor` 按消息对象共用同一次），没有为复读多拉一遍。
    assert.equal(images.hits.length, 2);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：不同的两张表情包不跟；表情包同样会打断文字链。
test('two different stickers do not repeat, and a sticker breaks a text chain', async () => {
  const first = await startImageServer(TINY_PNG);
  // 用另一张**真的不一样**的图（见 test/image-fixtures.mjs）：早先这里是在 TINY_PNG 后面
  // 追加几个字节假装「另一张」，但那两个文件在画面上其实是同一张 1×1 的图 —— 有了画面
  // 指纹之后，那种「伪不同」本来就该算同一张，不能再拿来当反例。
  const second = await startImageServer(OTHER_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(first.url(), { messageId: 150 }));
    onebot.push(groupSticker(second.url(), { messageId: 151, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);

    // 「6」→ 一张图 →「6」：中间那张图让前后两个 6 不再连着。
    onebot.push(groupText('6', { messageId: 152 }));
    onebot.push(groupSticker(first.url(), { messageId: 153, userId: 4444444444, card: 'mutsumi' }));
    onebot.push(groupText('6', { messageId: 154, userId: 5555555555, card: '路人' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await first.close();
    await second.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：同一张画面被 QQ 按发送者重新编码（字节不同）时照样跟 —— 这是 2026-10-13 那天
// 群里连着发同一张「寿来」却没触发复读的原因，也是这个功能最常见的真实形态。
test('the same picture re-encoded by QQ still counts as the same sticker', async () => {
  const asPng = await startImageServer(PIC_PNG, { contentType: 'image/png' });
  const asJpeg = await startImageServer(PIC_JPEG, { contentType: 'image/jpeg' });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(groupSticker(asPng.url(), { messageId: 200, file: 'A.png' }));
    await settle();
    // 只有一张时不跟：复读要有「连着」。
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupSticker(asJpeg.url(), { messageId: 201, userId: 3333333333, card: 'iroha', file: 'A.jpg' }));
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message)),
      'the repeated sticker',
    );
    // 跟出去的是**后一条**那张图（复读机接的是刚说的那句），原字节就是它的 JPEG 字节。
    assert.deepEqual(sentImageBytes(sent), PIC_JPEG);
    // 依然不建会话、不经过模型。
    assert.equal(host.list.created.length, 0);
  } finally {
    await onebot.close();
    await asPng.close();
    await asJpeg.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：repeatImageTolerance: 0 时回到「只认字节完全相同」的旧行为 —— 画面一样但字节
// 不同的两张不跟（用户想自己决定要不要这层画面比对时的出口，也是这条链路的开关）。
test('repeatImageTolerance: 0 turns the picture comparison off', async () => {
  const asPng = await startImageServer(PIC_PNG, { contentType: 'image/png' });
  const asJpeg = await startImageServer(PIC_JPEG, { contentType: 'image/jpeg' });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', repeatImageTolerance: 0 });
  try {
    onebot.push(groupSticker(asPng.url(), { messageId: 210, file: 'A.png' }));
    onebot.push(groupSticker(asJpeg.url(), { messageId: 211, userId: 3333333333, card: 'iroha', file: 'A.jpg' }));
    await settle(300);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await asPng.close();
    await asJpeg.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：系统表情（face 段）不用下载，连着两个一样的也照跟。
test('two identical system faces get echoed', async () => {
  const { onebot } = await boot();
  try {
    const face = (messageId, userId, card) => groupMessage([{ type: 'face', data: { id: '13' } }], { messageId, userId, card });
    onebot.push(face(160, 100000003, 'kaguya'));
    onebot.push(face(161, 3333333333, 'iroha'));
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the repeated face');
    assert.deepEqual(sent.params.message, [{ type: 'face', data: { id: '13' } }]);
  } finally {
    await onebot.close();
  }
});

// 用例：repeatMedia: false 只停掉表情包，文字照旧跟着复读。
test('repeatMedia: false keeps text repeats but drops stickers', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', repeatMedia: false });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 170 }));
    onebot.push(groupSticker(images.url(), { messageId: 171, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);

    onebot.push(groupText('6', { messageId: 172 }));
    onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 173 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the text repeat'), '6');
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：表情包复读用的是环境上下文那次落盘 —— ambientMedia: false 时图不下载，也就没有复读，
// 「不为闲聊花带宽」这个承诺不能被复读偷偷破坏。
test('sticker repeat rides on the ambient download', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media', ambientMedia: false });
  try {
    onebot.push(groupSticker(images.url(), { messageId: 180 }));
    onebot.push(groupSticker(images.url(), { messageId: 181, userId: 3333333333, card: 'iroha' }));
    await settle(200);
    assert.deepEqual(sentTexts(onebot), []);
    assert.equal(images.hits.length, 0);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：只有「一条纯文字」或「单独一张表情包」才复读 —— 图和话混着发、一条里两张图都不算。
test('only a single plain line or a single sticker is repeatable', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    const atOther = (messageId, userId) => groupMessage([{ type: 'at', data: { qq: 10001, name: 'kaguya' } }, { type: 'text', data: { text: '你好' } }], { messageId, userId, card: 'iroha' });
    const withReply = (messageId, userId) => groupMessage([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '6' } }], { messageId, userId, card: 'iroha' });
    const caption = (messageId, userId) => groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }, { type: 'text', data: { text: '笑死' } }], { messageId, userId, card: 'iroha' });
    const twoImages = (messageId, userId) => groupMessage([
      { type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } },
      { type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } },
    ], { messageId, userId, card: 'iroha' });
    for (const build of [atOther, withReply, caption, twoImages]) {
      onebot.push(build(190, 100000003));
      onebot.push(build(191, 3333333333));
    }
    await settle(300);
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例十五：自动回复拆成几条短消息，而不是一屏糊上来；条与条之间有打字间隔。
test('an automatic reply is burst into short messages', async () => {
  const reply = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  // 固定 30ms/条：既验证延迟确实接到了配置（delayJitter=0 时是确定值），又不拖慢测试。
  const { onebot, host } = await boot({
    burstMaxChars: 12,
    burstMaxParts: 3,
    readDelayMs: 0,
    minDelayMs: 30,
    maxDelayMs: 30,
    charsPerSecond: 1,
    delayJitter: 0,
  });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    const started = Date.now();
    completeTurn(host, agent, reply);

    const sent = await until(() => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.length === 3 ? list : undefined;
    }, 'the burst to be delivered');
    assert.deepEqual(sent, ['今天天气不错。', '要不出去走走？', '顺便吃个饭吧！']);
    // 每一条都在目标长度内（整体不超协议上限自然更没问题）。
    assert.ok(sent.every((part) => part.length <= 12));
    // 两条间隔 × 30ms：证明「打字延迟」真的按配置生效，而不是一口气发完。
    assert.ok(Date.now() - started >= 50, 'the burst should be paced out, not sent at once');
  } finally {
    await onebot.close();
  }
});

// 用例十六：humanize: false 回到旧行为 —— 一条整段直接发出。
test('humanize: false restores the single-message reply', async () => {
  const reply = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  const { onebot, host } = await boot({ humanize: false, burstMaxChars: 12 });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    completeTurn(host, agent, reply);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the reply');
    assert.equal(sent, reply);
    assert.equal(sentTexts(onebot, 'send_private_msg').length, 1);
  } finally {
    await onebot.close();
  }
});

// 用例十六·补：burstMaxMessages: 1 —— 一轮回复不管模型写了几行、几个句号，
// 都并成一条发出去（模型爱拆「短句 + 长句」两拍，光靠提示词压不住）。
test('burstMaxMessages: 1 collapses a whole reply into a single message', async () => {
  // 同一个句子里被标点拆出来的几段：接回去应当和原文一模一样（不留痕）。
  const oneLine = '今天天气不错。要不出去走走？顺便吃个饭吧！';
  const first = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    first.onebot.push(privateMessage('在吗'));
    const agent = await until(() => first.host.list.created[0], 'the Agent');
    completeTurn(first.host, agent, oneLine);
    const sent = await until(() => sentTexts(first.onebot, 'send_private_msg')[0], 'the single reply');
    assert.deepEqual(sentTexts(first.onebot, 'send_private_msg'), [oneLine]);
    assert.equal(sent, oneLine);
  } finally {
    await first.onebot.close();
  }

  // 模型自己换行写的两段：跨行合并用空格接，仍然只有一条。
  const multiline = '今天天气不错。\n要不出去走走？顺便吃个饭吧！';
  const second = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    second.onebot.push(privateMessage('在吗'));
    const agent = await until(() => second.host.list.created[0], 'the Agent');
    completeTurn(second.host, agent, multiline);
    await until(() => sentTexts(second.onebot, 'send_private_msg')[0], 'the single reply');
    assert.deepEqual(sentTexts(second.onebot, 'send_private_msg'), ['今天天气不错。 要不出去走走？顺便吃个饭吧！']);
  } finally {
    await second.onebot.close();
  }

  // 长内容不会被这一段吞掉：并条只影响「分几条」，内容一字不动；真的超过协议上限
  // （maxReplyChars）时仍然按上限切成两段 —— 那是 QQ 协议的限制，不是这条配置。
  const third = await boot({ burstMaxChars: 12, burstMaxParts: 3, burstMaxMessages: 1, maxReplyChars: 20, readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    third.onebot.push(privateMessage('在吗'));
    const agent = await until(() => third.host.list.created[0], 'the Agent');
    completeTurn(third.host, agent, oneLine);
    await until(() => sentTexts(third.onebot, 'send_private_msg').length === 2, 'the protocol-limit chunks');
    const chunks = sentTexts(third.onebot, 'send_private_msg');
    assert.ok(chunks.every((part) => part.length <= 20));
    assert.equal(chunks.join(''), oneLine, '内容必须一字不少');
  } finally {
    await third.onebot.close();
  }
});

// 用例十六·补二：burstSingleMaxChars —— 日常闲聊并成一条，真要展开时才拆成多条短句。
// 这是默认的口味：模型爱把一句话写成「短句 + 长句」两拍，靠长度门槛而不是提示词压住。
test('burstSingleMaxChars keeps chit-chat to one message and splits long answers', async () => {
  const options = {
    burstMaxChars: 12,
    burstMaxParts: 3,
    burstMaxMessages: 0, // 长回复不封顶：该拆几条拆几条
    burstSingleMaxChars: 20,
    readDelayMs: 0,
    minDelayMs: 0,
    maxDelayMs: 0,
    delayJitter: 0,
  };

  // 短回复（去掉空白 5 字 < 20）：换行写的两段也并成一条。
  const short = await boot(options);
  try {
    short.onebot.push(privateMessage('在吗'));
    const agent = await until(() => short.host.list.created[0], 'the Agent');
    completeTurn(short.host, agent, '在的\n刚吃完');
    await until(() => sentTexts(short.onebot, 'send_private_msg')[0], 'the single reply');
    assert.deepEqual(sentTexts(short.onebot, 'send_private_msg'), ['在的 刚吃完']);
  } finally {
    await short.onebot.close();
  }

  // 长回复（去掉空白 28 字 > 20）：换行照旧分条，一行一条短句（这就是「需要深入时多条短句」）。
  const long = '今天天气不错\n要不要出去走走\n顺便吃个饭吧\n附近新开的店还不错';
  const deep = await boot(options);
  try {
    deep.onebot.push(privateMessage('在吗'));
    const agent = await until(() => deep.host.list.created[0], 'the Agent');
    completeTurn(deep.host, agent, long);
    const sent = await until(() => {
      const list = sentTexts(deep.onebot, 'send_private_msg');
      return list.length === 4 ? list : undefined;
    }, 'the split answer');
    assert.deepEqual(sent, ['今天天气不错', '要不要出去走走', '顺便吃个饭吧', '附近新开的店还不错']);
    assert.ok(sent.every((part) => part.length <= 12));
  } finally {
    await deep.onebot.close();
  }
});

// 用例十六·补三：两条「反人机」硬要求必须在渠道提示里，而且换成自定义 persona 也照样生效：
//   ① 一条回复只有一个形状（要么短、要么长）—— 压住「短句 + 长句」两拍；
//   ② 是 / 否题只回一个是 / 否 ——「知不知道」这种别接一段解释。
test('the channel prompt carries the anti-robot reply rules', async () => {
  const plain = await boot({});
  try {
    plain.onebot.push(privateMessage('在吗'));
    await until(() => plain.host.list.created[0], 'the Agent');
    const text = promptText(plain.host, 'qq-bridge:channel');
    assert.match(text, /一条回复只有一个形状/);
    assert.match(text, /是 \/ 否题就回一个是 \/ 否/);
    assert.match(text, /知不知道/);
  } finally {
    await plain.onebot.close();
  }

  // 自定义 persona 会整段替换内置那份口吻，但这两条硬要求挂在「硬性要求」里，必须还在；
  // 同时内置 persona 的那句「像真人群友一样」应当已经不在了（证明确实被替换）。
  const custom = await boot({ persona: '你是个普通群友，说话随意。' });
  try {
    custom.onebot.push(privateMessage('在吗'));
    await until(() => custom.host.list.created[0], 'the Agent');
    const text = promptText(custom.host, 'qq-bridge:channel');
    assert.match(text, /一条回复只有一个形状/);
    assert.match(text, /是 \/ 否题就回一个是 \/ 否/);
    assert.ok(text.includes('你是个普通群友，说话随意。'));
    assert.ok(!text.includes('像真人群友一样'));
  } finally {
    await custom.onebot.close();
  }
});

// 用例十七：群聊回复可以带上指向（引用被回复的消息 / @ 对方），且只挂在第一条上。
test('group replies can quote or mention the message they answer', async () => {
  // quote（默认）：reply 段引用入站消息的 message_id，正文跟在后面。
  const quoted = await boot({ replyStyle: 'quote' });
  try {
    quoted.onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await until(() => quoted.host.list.created[0], 'the group Agent');
    completeTurn(quoted.host, agent, '在的');
    const sent = await until(() => sentTexts(quoted.onebot)[0], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4242' } },
      { type: 'text', data: { text: '在的' } },
    ]);
  } finally {
    await quoted.onebot.close();
  }

  // at：改成 @ 回提问者。
  const mentioned = await boot({ replyStyle: 'at' });
  try {
    mentioned.onebot.push(mention('在吗', { messageId: 4242, userId: 100000003 }));
    const agent = await until(() => mentioned.host.list.created[0], 'the group Agent');
    completeTurn(mentioned.host, agent, '在的');
    const sent = await until(() => sentTexts(mentioned.onebot)[0], 'the mentioned reply');
    assert.deepEqual(sent, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: '在的' } },
    ]);
  } finally {
    await mentioned.onebot.close();
  }

  // plain：保持纯文本，私聊任何时候都不带指向段。
  const plain = await boot({ replyStyle: 'plain' });
  try {
    plain.onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await until(() => plain.host.list.created[0], 'the group Agent');
    completeTurn(plain.host, agent, '在的');
    assert.equal(await until(() => sentTexts(plain.onebot)[0], 'the plain reply'), '在的');
  } finally {
    await plain.onebot.close();
  }
});

// 用例十七之二：auto（默认）—— 紧挨着回不引用，中间有人插话才引用。
test('auto reply style quotes only when someone spoke in between', async () => {
  const { onebot, host } = await boot({ replyStyle: 'auto' });
  try {
    // 没人插话：一轮问答本来就看得出来在回谁，裸文本就够了。
    onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    completeTurn(host, agent, '在的');
    assert.equal(await until(() => sentTexts(onebot)[0], 'the plain reply'), '在的');

    // @ 之后群里又有人说话：回复带上引用，否则看不出在回哪一条。
    onebot.push(mention('几点走', { messageId: 4243 }));
    await until(() => agent.inbox.length === 2, 'the second message to be delivered');
    onebot.push(groupMessage([{ type: 'text', data: { text: '我也想问' } }], { userId: 333, name: 'iroha', card: 'iroha', messageId: 4244 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    completeTurn(host, agent, '八点', 2);
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4243' } },
      { type: 'text', data: { text: '八点' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例十七之三：一次回复里的换行拆成多条独立消息，且引用只挂在第一条上。
test('a multiline group reply becomes separate messages with the quote only on the first', async () => {
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    completeTurn(host, agent, '在的\n刚吃完\n你呢');
    const sent = await until(() => {
      const list = sentTexts(onebot);
      return list.length === 3 ? list : undefined;
    }, 'the three messages to be delivered');
    // 三条独立消息；只有第一条带 reply 段，后两条是纯文本。
    assert.deepEqual(sent, [
      [
        { type: 'reply', data: { id: '4242' } },
        { type: 'text', data: { text: '在的' } },
      ],
      '刚吃完',
      '你呢',
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例十八：修两个「不像真人」的旧毛病 —— 群名从第二条消息起不再丢失，
// 提示词里的「刚跟你说话的人」也永远是当前这位，而不是建 Agent 时的第一位。
test('the channel prompt keeps the group name and always names the latest speaker', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗', { messageId: 11 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const first = promptText(host, 'qq-bridge:channel');
    // 群名来自 get_group_info（入站事件里没有），第一条消息时就该查到。
    assert.ok(first.includes('示例群'), first);
    assert.ok(first.includes('刚跟你说话的人：kaguya'));

    onebot.push(mention('还在吗', { messageId: 12, userId: 333, name: 'iroha', card: 'iroha' }));
    await until(() => agent.inbox.length === 2, 'the second message to be delivered');
    const second = await until(() => {
      const text = promptText(host, 'qq-bridge:channel');
      return text.includes('刚跟你说话的人：iroha') ? text : undefined;
    }, 'the prompt to name the new speaker');
    // 群名没有被下一条消息冲成空串。
    assert.ok(second.includes('示例群'), second);
  } finally {
    await onebot.close();
  }
});

// 用例十九：拆句与打字延迟的纯函数（时间相关的行为在这里精确验证，避免集成测试抖动）。
test('splitBurst and typingDelayMs behave as documented', () => {
  // 短文本不拆。
  assert.deepEqual(splitBurst('在的', 60, 3), ['在的']);
  // 空文本得到空数组。
  assert.deepEqual(splitBurst('   ', 60, 3), []);
  // 在句末标点处断句，而不是硬切。
  assert.deepEqual(splitBurst('a。b。c。', 4, 3), ['a。b。', 'c。']);
  // 没有任何标点时按长度硬切。
  assert.deepEqual(splitBurst('abcdefghij', 4, 3), ['abcd', 'efgh', 'ij']);
  // 超过 maxParts 的余量并进最后一条（宁可长一点，也不刷屏）。
  assert.deepEqual(splitBurst('一。二。三。四。五。', 4, 2), ['一。二。', '三。四。五。']);
  // maxChars 非正数 = 不拆。
  assert.deepEqual(splitBurst('一。二。三。', 0, 3), ['一。二。三。']);
  // 换行是消息边界：一行一条，不再塞进同一条里换行；空行不算消息。
  assert.deepEqual(splitBurst('在的\n刚吃完\n你呢', 60, 3), ['在的', '刚吃完', '你呢']);
  assert.deepEqual(splitBurst('一\n\n二\n', 60, 3), ['一', '二']);
  // 每一行各自按长度拆：短行不并回同一条，长行才继续拆。
  assert.deepEqual(splitBurst('一。\n二。三。四。', 4, 2), ['一。', '二。三。', '四。']);
  // maxChars = 0 只关掉「长句自动拆」，换行照样分条。
  assert.deepEqual(splitBurst('a\nb', 0, 3), ['a', 'b']);
  // maxMessages：整轮回复的总条数上限。默认 0 = 不限（上面那些用例就是这个行为）。
  // 同一行内部并条是「接回原文」，不留空格；跨行并条补一个空格，不能把两句粘成一个词。
  assert.deepEqual(splitBurst('a。b。c。', 4, 3, 1), ['a。b。c。']);
  assert.deepEqual(splitBurst('a。b。c。', 4, 3, 2), ['a。b。', 'c。']);
  assert.deepEqual(splitBurst('在的\n刚吃完\n你呢', 60, 3, 1), ['在的 刚吃完 你呢']);
  assert.deepEqual(splitBurst('在的\n刚吃完', 60, 3, 1), ['在的 刚吃完']);
  // 额度内不并：一条就够时原样返回。
  assert.deepEqual(splitBurst('在的', 60, 3, 1), ['在的']);
  // 空文本仍然是空数组。
  assert.deepEqual(splitBurst('   ', 60, 3, 1), []);

  const base = { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 60000, jitter: 0 };
  // 打字时间 = 字数 / 速度。
  assert.equal(typingDelayMs(100, base), 10000);
  // 下限与上限都生效。
  assert.equal(typingDelayMs(1, { ...base, minDelayMs: 300 }), 300);
  assert.equal(typingDelayMs(100, { ...base, maxDelayMs: 2000 }), 2000);
  // baseMs 叠加在打字时间之上（「读消息」那一段）。
  assert.equal(typingDelayMs(10, { ...base, baseMs: 500 }), 1500);
  // 抖动：random()=1 时上浮 jitter 比例，random()=0 时下浮同样的比例。
  const jittered = { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 60000, jitter: 0.5, baseMs: 1000 };
  assert.equal(typingDelayMs(10, jittered, () => 1), 3000);
  assert.equal(typingDelayMs(10, jittered, () => 0), 1000);
  // 测试/关闭延迟的写法：上下限都为 0 时恒为 0。
  assert.equal(typingDelayMs(500, { charsPerSecond: 10, minDelayMs: 0, maxDelayMs: 0, jitter: 0.9 }, () => 1), 0);
});

// 用例十九之二：复读候选的纯函数 —— 只有整条都是文字时才拿得到原文。
test('repeatableText only accepts messages made of plain text', () => {
  // 文字段拼起来就是原文（不 trim，交给调用方决定怎么归一化）。
  assert.equal(repeatableText([{ type: 'text', data: { text: '  6 ' } }]), '  6 ');
  assert.equal(repeatableText([{ type: 'text', data: { text: '草' } }, { type: 'text', data: { text: '死了' } }]), '草死了');
  // 空数组拿到空串（调用方按「正文为空」丢掉）。
  assert.equal(repeatableText([]), '');
  // 图 / 表情 / @ / 引用 / 卡片：只要掺了一段就不复读。
  assert.equal(repeatableText([{ type: 'text', data: { text: '6' } }, { type: 'image', data: {} }]), undefined);
  assert.equal(repeatableText([{ type: 'face', data: { id: '13' } }]), undefined);
  assert.equal(repeatableText([{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: '你好' } }]), undefined);
  assert.equal(repeatableText([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '6' } }]), undefined);
  assert.equal(repeatableText([{ type: 'json', data: { data: '{}' } }]), undefined);
  // CQ 码字符串：看不出里面藏了什么，含 [CQ: 就放弃；普通句子照收。
  assert.equal(repeatableText('6'), '6');
  assert.equal(repeatableText('[CQ:image,file=x.jpg]'), undefined);
  // 不是消息段数组（字段缺失、上报格式不认识）时什么都不复读。
  assert.equal(repeatableText(undefined), undefined);
  assert.equal(repeatableText({ type: 'text', data: { text: '6' } }), undefined);
});

// ---------------------------------------------------------------------------
// 「读表情包」相关行为：图片/表情包落盘、占位文本、抓不到时的降级。
// ---------------------------------------------------------------------------

// 用例二十：媒体段的收集与渲染（纯函数）。
test('media segments are collected and rendered with their local path', () => {
  const message = [
    { type: 'at', data: { qq: SELF_ID } },
    { type: 'image', data: { summary: '[动画表情]', url: 'https://example.invalid/a', file: 'A.png', file_size: '2048' } },
    { type: 'text', data: { text: '看这个' } },
    { type: 'mface', data: { emoji_id: '42', summary: '猫猫' } },
    { type: 'face', data: { id: '14' } },
  ];
  assert.deepEqual(collectMedia(message), [
    { index: 1, kind: 'image', label: '动画表情', url: 'https://example.invalid/a', file: 'A.png', declaredBytes: 2048 },
    { index: 3, kind: 'mface', label: '猫猫', url: '', file: '', declaredBytes: undefined },
  ]);
  // 纯文本消息（以及 CQ 码字符串）里没有媒体段。
  assert.deepEqual(collectMedia([{ type: 'text', data: { text: 'hi' } }]), []);
  assert.deepEqual(collectMedia('[CQ:image,file=x.png]'), []);

  // 没有映射时就是朴素占位符 —— 媒体还没落盘、下载失败、或 mediaDownload / ambientMedia 关掉时。
  assert.equal(messageToText(message, SELF_ID), '[图片(动画表情)]看这个[表情包(猫猫)][表情]');
  // 有映射时整段被替换成本地路径，模型才知道该 read_image 哪个文件。
  const media = new Map([[1, mediaPlaceholder({ kind: 'image', label: '动画表情' }, '.qq-media/ab.gif')]]);
  assert.equal(messageToText(message, SELF_ID, media), '[图片(动画表情): .qq-media/ab.gif]看这个[表情包(猫猫)][表情]');
  // 抓不到文件时明说，而不是让模型对着一张不存在的图使劲。
  assert.equal(mediaPlaceholder({ kind: 'image', label: '动画表情' }, '', 'HTTP 404'), '[图片(动画表情) 没能取到文件: HTTP 404]');
  assert.equal(mediaPlaceholder({ kind: 'mface', label: '' }, '', 'x'), '[表情包 没能取到文件: x]');

  // summary 的方括号被剥掉，纯空白不算标签。
  assert.equal(mediaLabel('[动画表情]'), '动画表情');
  assert.equal(mediaLabel(' \n '), '');
  assert.equal(mediaLabel(undefined), '');
});

// 用例二十一：魔数识别只认 read_image 支持的那四种格式。
test('sniffImageExtension recognises exactly the four readable formats', () => {
  assert.equal(sniffImageExtension(TINY_PNG), 'png');
  assert.equal(sniffImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'jpg');
  assert.equal(sniffImageExtension(Buffer.from('GIF89a....', 'latin1')), 'gif');
  assert.equal(sniffImageExtension(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  // 腾讯的下载链接不带扩展名，认格式只能靠字节；认不出来就拒绝落盘。
  assert.equal(sniffImageExtension(Buffer.from('<html>404</html>')), undefined);
  assert.equal(sniffImageExtension(Buffer.alloc(0)), undefined);
});

// 用例二十二：私聊里发来的图片会落盘，Agent 拿到的是可以 read_image 的路径。
test('an inbound image is downloaded so the agent can actually read it', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '你看这个' }));
    // 等「消息真的投递了」而不是「Agent 建出来了」：媒体是先落盘再投递的，
    // 中间隔着一个真实的 HTTP 往返，只看 created 会读到还没进收件箱的 Agent。
    await until(() => host.list.created[0]?.inbox.length === 1, 'the image message to be delivered');
    const body = host.list.created[0].inbox[0].content[0].text;
    // 占位符里带着相对 cwd 的路径，正文其余部分原样保留。
    const match = /\[图片\(动画表情\): (media\/([0-9a-f]{32})\.png)\]你看这个/.exec(body);
    assert.ok(match, body);
    // 落盘的必须是原字节（而不是被截断/转码过的东西）。
    assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
    assert.equal(images.hits.length, 1);

    // 提示词要告诉模型「这类路径是可以读的」，否则它只会对着路径发呆。
    const prompt = promptText(host, 'qq-bridge:channel');
    assert.ok(prompt.includes('read_image'), prompt);
    assert.ok(prompt.includes('`[图片: 路径]`'), prompt);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例二十三：同一张图反复发只存一份；超过上限就按最近使用时间淘汰最旧的。
test('the media cache dedupes by content and evicts the oldest files', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '一' }));
    onebot.push(privateMessageWithImage(images.url(), { text: '二' }));
    await until(() => host.list.created[0]?.inbox.length === 2, 'both messages to be delivered');
    // 下载了两次（每次都是新消息），但内容哈希相同 -> 缓存里只有一个文件。
    assert.equal(images.hits.length, 2);
    assert.equal((await readdir(join(mediaRoot, 'media'))).length, 1);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 淘汰：手工造三个文件并拉开 mtime，只留最近的两个。
  const store = createMediaStore({ cwd: mediaRoot, dir: 'media', maxFiles: 2 });
  await mkdir(join(mediaRoot, 'media'), { recursive: true });
  const names = ['old.png', 'middle.png', 'new.png'];
  for (const [index, name] of names.entries()) {
    const target = join(mediaRoot, 'media', name);
    await writeFile(target, TINY_PNG);
    const when = new Date(Date.now() - (names.length - index) * 60_000);
    await utimes(target, when, when);
  }
  await store.prune();
  assert.deepEqual((await readdir(join(mediaRoot, 'media'))).sort(), ['middle.png', 'new.png']);
  await rm(mediaRoot, { recursive: true, force: true });
});

// 用例二十四：群聊环境上下文里的图默认也落盘（「刚才那张表情包」@ 它时它真的看得见）；
// ambientMedia: false 退回成「不为闲聊花带宽和磁盘」的老行为。
test('images in group chatter are downloaded unless ambientMedia is off', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  try {
    // 没被 @ 的群消息：只记进环境缓冲，但图会异步落盘。
    onebot.push(groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }], { messageId: 21 }));
    await until(() => images.hits.length === 1, 'the ambient image to be downloaded');
    assert.equal(host.list.created.length, 0);

    // 随后被 @：上下文里那条已经改写成带路径的版本，模型可以 read_image。
    onebot.push(mention('这啥', { messageId: 22 }));
    await until(() => host.list.created[0], 'the group Agent');
    const prompt = await until(
      () => (/kaguya: \[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]/.exec(promptText(host, 'qq-bridge:channel')) ?? undefined),
      'the ambient line to carry the local path',
    );
    // 落盘的确实是原字节。
    assert.deepEqual(await readFile(join(mediaRoot, prompt[1])), TINY_PNG);
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 关掉开关：一条请求都不发，上下文里只有朴素占位符。
  const quietImages = await startImageServer(TINY_PNG);
  const quietRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const quiet = await boot({ cwd: quietRoot, mediaDir: 'media', ambientMedia: false });
  try {
    quiet.onebot.push(groupMessage([{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: quietImages.url() } }], { messageId: 21 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(quietImages.hits.length, 0, 'ambient images must not be downloaded when ambientMedia is off');
    quiet.onebot.push(mention('这啥', { messageId: 22 }));
    await until(() => quiet.host.list.created[0], 'the group Agent');
    const prompt = promptText(quiet.host, 'qq-bridge:channel');
    assert.ok(prompt.includes('[图片(动画表情)]'), prompt);
    // 只断言「没有真的落盘路径」：提示词里作为例子提到 `.qq-media/…` 是另一回事。
    assert.ok(!/media\/[0-9a-f]{32}\./.test(prompt), prompt);
    assert.equal(quietImages.hits.length, 0);
  } finally {
    await quiet.onebot.close();
    await quietImages.close();
    await rm(quietRoot, { recursive: true, force: true });
  }
});

// 用例二十四之二：被引用的那条消息会被 get_msg 取回来 —— 引用一张表情包再 @ 它，图能落盘；
// 引用纯文本时原文直接进正文；实现不支持 get_msg 时安静降级成 `[回复]`。
test('a quoted message is fetched so quoted images become readable', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const asked = [];
  const { onebot, host } = await boot({ cwd: mediaRoot, mediaDir: 'media' }, {}, {
    getMsg: async (params) => {
      asked.push(params.message_id);
      return {
        message_id: params.message_id,
        sender: { card: 'kaguya', nickname: 'tomori', user_id: 100000003 },
        message: [{ type: 'image', data: { summary: '[动画表情]', file: 'A.png', url: images.url() } }],
      };
    },
  });
  try {
    // 「引用某条消息 + @bot 这啥」：图不在本条消息里，只在被引用的那条里。
    onebot.push(groupMessage([
      { type: 'reply', data: { id: '7001' } },
      { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
      { type: 'text', data: { text: '这啥表情' } },
    ], { messageId: 7002 }));
    await until(() => host.list.created[0]?.inbox.length === 1, 'the quoting message to be delivered');
    const body = host.list.created[0].inbox[0].content[0].text;
    // message_id 按整数传给 get_msg（NapCat 的形状），引用前缀里带的是可 read_image 的路径。
    assert.deepEqual(asked, [7001]);
    const match = /^（引用 kaguya: \[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]）\n这啥表情$/.exec(body);
    assert.ok(match, body);
    assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
    // 提示词要交代「（引用 某某: …）」是什么，否则模型会把它读成对方原话的一部分。
    assert.ok(promptText(host, 'qq-bridge:channel').includes('（引用 某某: …）'));
  } finally {
    await onebot.close();
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }

  // 引用纯文本：原文进正文，不需要任何媒体。
  const textRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const quotedText = await boot({ cwd: textRoot, mediaDir: 'media' }, {}, {
    getMsg: async () => ({ sender: { card: 'iroha' }, message: [{ type: 'text', data: { text: '你看这个 https://example.com/a' } }] }),
  });
  try {
    quotedText.onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => quotedText.host.list.created[0]?.inbox.length === 1, 'the quoting private message to be delivered');
    assert.equal(
      quotedText.host.list.created[0].inbox[0].content[0].text,
      '（引用 iroha: 你看这个 https://example.com/a）\n在吗',
    );
  } finally {
    await quotedText.onebot.close();
    await rm(textRoot, { recursive: true, force: true });
  }

  // 实现不支持 get_msg：只记一条 warn，正文照常投递，引用退化成 `[回复]`。
  const bareRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const bare = await boot({ cwd: bareRoot, mediaDir: 'media' });
  try {
    bare.onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => bare.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
    assert.equal(bare.host.list.created[0].inbox[0].content[0].text, '[回复]在吗');
    assert.ok(
      bare.host.list.warnings.some((line) => line.includes('could not fetch message 6650')),
      bare.host.list.warnings.join('\n'),
    );
  } finally {
    await bare.onebot.close();
    await rm(bareRoot, { recursive: true, force: true });
  }
});

// 用例二十四之三：quoteMedia: false 回到老行为 —— 引用段就是一句 `[回复]`，一次 get_msg 都不发。
test('quoteMedia: false leaves the reply segment as a bare placeholder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const asked = [];
  const { onebot, host } = await boot({ cwd: root, mediaDir: 'media', quoteMedia: false }, {}, {
    getMsg: async (params) => {
      asked.push(params.message_id);
      return { message: [{ type: 'text', data: { text: '不该被取回来' } }] };
    },
  });
  try {
    onebot.push(privateMessageWithReply('在吗', '6650'));
    await until(() => host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
    assert.equal(host.list.created[0].inbox[0].content[0].text, '[回复]在吗');
    assert.deepEqual(asked, []);
  } finally {
    await onebot.close();
    await rm(root, { recursive: true, force: true });
  }
});

// 用例二十五：抓不到图（rkey 过期 / CDN 报错）时降级成占位符，消息本身照常送达；
// 还能靠 OneBot 的 get_image 兜底拿到 base64。
test('a failing image download degrades, and get_image can still save it', async () => {
  const dead = await startImageServer(TINY_PNG, { status: 404 });
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  try {
    // 一：URL 抓不动、OneBot 也不支持 get_image -> 只留一句「没能取到文件」。
    const plain = await boot({ cwd: mediaRoot, mediaDir: 'media' });
    try {
      plain.onebot.push(privateMessageWithImage(dead.url(), { text: '在吗' }));
      await until(() => plain.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      const body = plain.host.list.created[0].inbox[0].content[0].text;
      assert.match(body, /^\[图片\(动画表情\) 没能取到文件: [^\]]+\]在吗$/, body);
      assert.ok(plain.host.list.warnings.some((line) => line.includes('could not fetch image')));
    } finally {
      await plain.onebot.close();
    }

    // 二：URL 依然不行，但 get_image 回了 base64 -> 照样落盘、正文里给出路径。
    const rescued = await boot({ cwd: mediaRoot, mediaDir: 'media' }, {}, { getImage: () => ({ base64: TINY_PNG.toString('base64') }) });
    try {
      rescued.onebot.push(privateMessageWithImage(dead.url(), { text: '在吗' }));
      await until(() => rescued.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      const body = rescued.host.list.created[0].inbox[0].content[0].text;
      const match = /\[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]在吗/.exec(body);
      assert.ok(match, body);
      assert.deepEqual(await readFile(join(mediaRoot, match[1])), TINY_PNG);
      assert.ok(rescued.onebot.calls.some((call) => call.action === 'get_image'));
    } finally {
      await rescued.onebot.close();
    }
  } finally {
    await dead.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例二十六：mediaDownload: false 完全不碰网络；超过 mediaMaxBytes 的图不下载。
test('media download can be turned off and oversized images are skipped', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  try {
    const off = await boot({ cwd: mediaRoot, mediaDir: 'media', mediaDownload: false });
    try {
      off.onebot.push(privateMessageWithImage(images.url(), { text: '看图' }));
      await until(() => off.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      assert.equal(off.host.list.created[0].inbox[0].content[0].text, '[图片(动画表情)]看图');
      assert.equal(images.hits.length, 0);
    } finally {
      await off.onebot.close();
    }

    // 图上标着 file_size 且超过上限：连请求都不发。
    const capped = await boot({ cwd: mediaRoot, mediaDir: 'media', mediaMaxBytes: 1024 });
    try {
      capped.onebot.push(privateMessageWithImage(images.url(), { text: '看图', fileSize: 999999 }));
      await until(() => capped.host.list.created[0]?.inbox.length === 1, 'the message to be delivered');
      assert.match(capped.host.list.created[0].inbox[0].content[0].text, /^\[图片\(动画表情\) 没能取到文件: too large/);
      assert.equal(images.hits.length, 0);
      // 提示词里仍然会提图片这件事（下载能力是开着的，只是这张图太大）。
      assert.ok(promptText(capped.host, 'qq-bridge:channel').includes('read_image'));
    } finally {
      await capped.onebot.close();
    }
  } finally {
    await images.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例二十七：缓存目录被配置到 cwd 外面时必须整体停用 —— 写出去的图 Agent 读不到，
// 而且那是把文件丢到工作区外面去。
test('a media directory outside cwd disables the cache', async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const warnings = [];
  const store = createMediaStore({ cwd: mediaRoot, dir: '../escape', report: (level, message) => warnings.push(message) });
  assert.equal(store.enabled, false);
  assert.ok(warnings.some((line) => line.includes('outside cwd')), warnings.join('|'));
  const outcome = await store.resolve({ kind: 'image', url: 'http://127.0.0.1:1/x.png' });
  assert.equal(outcome.path, undefined);
  await rm(mediaRoot, { recursive: true, force: true });
});

// ---- 表情包 / 发图：工作目录里的图 → QQ --------------------------------------
// 上面的媒体用例是入站（QQ 的图 → 本地文件），这一组是出站（本地文件/URL → QQ）。
// 传输走 OneBot image 段的 `base64://`（NapCat 在容器里，本地路径它读不到），
// 所以这里真正要钉住的是：发出去的确实是一个 image 段，且 base64 解出来是原字节。

/**
 * 起一个「有表情包」的插件实例：cwd 是新临时目录，里面放一张真 PNG 与一个假图片。
 * @param config - 插件配置（覆盖默认的 cwd）。
 */
async function bootImages(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-image-'));
  await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
  await writeFile(join(cwd, '.qq-stickers', '笑死.png'), TINY_PNG);
  await writeFile(join(cwd, 'notes.txt'), 'definitely not an image');
  const booted = await boot({ cwd, ...config }, hostOptions, onebotOptions);
  return { ...booted, cwd };
}

test('loadOutgoingImage reads paths inside cwd and URLs, and refuses everything else', async () => {
  const images = await startImageServer(TINY_PNG);
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-image-'));
  try {
    await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
    await writeFile(join(cwd, '.qq-stickers', '笑死.png'), TINY_PNG);
    await writeFile(join(cwd, 'notes.txt'), 'definitely not an image');

    const local = await loadOutgoingImage({ source: '.qq-stickers/笑死.png', cwd });
    assert.equal(local.format, 'png');
    assert.deepEqual(local.bytes, TINY_PNG);
    assert.equal(local.label, '.qq-stickers/笑死.png');

    // `file://` 也认，但同样受「必须在工作目录里」的约束。
    const viaFileUrl = await loadOutgoingImage({ source: pathToFileURL(join(cwd, '.qq-stickers', '笑死.png')).href, cwd });
    assert.deepEqual(viaFileUrl.bytes, TINY_PNG);
    assert.equal(viaFileUrl.label, '.qq-stickers/笑死.png');

    // URL：插件自己先下下来（顺便校验格式），而不是把链接原样丢给 NapCat。
    const url = images.url('/meme.png');
    const remote = await loadOutgoingImage({ source: url, cwd });
    assert.equal(remote.format, 'png');
    assert.deepEqual(remote.bytes, TINY_PNG);
    assert.equal(remote.label, url);
    assert.equal(images.hits.length, 1);

    await assert.rejects(() => loadOutgoingImage({ source: '   ', cwd }), /no image given/);
    await assert.rejects(() => loadOutgoingImage({ source: 'notes.txt', cwd }), /not a PNG\/JPEG\/WebP\/GIF/);
    await assert.rejects(() => loadOutgoingImage({ source: 'no-such-file.png', cwd }), /not a local file/);
    await assert.rejects(() => loadOutgoingImage({ source: '../outside.png', cwd }), /inside the working directory/);
    await assert.rejects(() => loadOutgoingImage({ source: pathToFileURL('/etc/hostname').href, cwd }), /inside the working directory/);
    await assert.rejects(() => loadOutgoingImage({ source: 'ftp://example.com/a.png', cwd }), /unsupported image source/);
    await assert.rejects(() => loadOutgoingImage({ source: 'http://127.0.0.1:1/x.png', cwd, timeoutMs: 800 }), /could not download/);
    await assert.rejects(() => loadOutgoingImage({ source: '.qq-stickers/笑死.png', cwd, maxBytes: 10 }), /larger than 10 bytes/);

    // 段形状：base64 放在 file 里（NapCat 的发送侧按 [url, file, path] 取第一个有值的字段）。
    const segment = imageSegment(TINY_PNG);
    assert.equal(segment.type, 'image');
    assert.match(segment.data.file, /^base64:\/\//);
    assert.deepEqual(Buffer.from(segment.data.file.slice('base64://'.length), 'base64'), TINY_PNG);
  } finally {
    await images.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('qq_send_image sends a sticker to the QQ conversation the calling Agent belongs to', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent');

  const tool = host.tools.get('qq_send_image');
  assert.ok(tool, 'qq_send_image should be registered');
  const value = await tool.execute({ image: '.qq-stickers/笑死.png' }, { agent });

  assert.equal(value.target_type, 'private');
  assert.equal(value.target_id, '100000002');
  assert.equal(value.format, 'png');
  assert.equal(value.bytes, TINY_PNG.length);
  const sent = onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message));
  assert.ok(sent, 'an image message must reach QQ');
  assert.equal(sent.params.user_id, '100000002');
  assert.equal(sent.params.message.length, 1);
  assert.equal(sent.params.message[0].type, 'image');
  assert.deepEqual(Buffer.from(sent.params.message[0].data.file.replace('base64://', ''), 'base64'), TINY_PNG);
});

test('qq_send_image can send back a picture the conversation already downloaded', async () => {
  const images = await startImageServer(TINY_PNG);
  const { onebot, host } = await bootImages({ mediaDir: 'media' });
  try {
    // 「对方发了张表情包」→ 正文里给出落盘路径 → 模型把那张原样发回去。
    onebot.push(privateMessageWithImage(images.url(), { text: '你看这个' }));
    const agent = await until(() => host.list.created[0], 'the conversation Agent');
    // 入队与建 Agent 之间隔着一次下载，所以正文要等它真的进了收件箱。
    const body = await until(() => agent.inbox[0]?.content[0]?.text, 'the message body to reach the Agent');
    const path = /\[图片\(动画表情\): ([^\]]+)\]/.exec(body)?.[1];
    assert.ok(path, body);

    const value = await host.tools.get('qq_send_image').execute({ image: path }, { agent });
    assert.equal(value.source, path);
    assert.equal(value.bytes, TINY_PNG.length);
    const sent = onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message));
    assert.equal(sent.params.message[0].type, 'image');
  } finally {
    await onebot.close();
    await images.close();
  }
});

test('qq_send_image needs a target outside a QQ conversation and can post to a group', async () => {
  const { onebot, host } = await bootImages();
  const tool = host.tools.get('qq_send_image');

  await assert.rejects(() => tool.execute({ image: '.qq-stickers/笑死.png' }, {}), /target_type and target_id/);
  const value = await tool.execute({ image: '.qq-stickers/笑死.png', target_type: 'group', target_id: '100000001' }, {});
  assert.equal(value.target_type, 'group');
  assert.equal(value.target_id, '100000001');
  const sent = onebot.calls.find((call) => call.action === 'send_group_msg');
  assert.equal(sent.params.group_id, '100000001');
  assert.equal(sent.params.message[0].type, 'image');
});

test('qq_send_image refuses non-images, oversized files, and paths outside cwd', async () => {
  const { onebot, host } = await bootImages({ imageMaxBytes: 32 });
  onebot.push(privateMessage('在吗'));
  await until(() => host.list.created[0], 'the conversation Agent');
  const tool = host.tools.get('qq_send_image');
  const target = { target_type: 'private', target_id: '100000002' };

  await assert.rejects(() => tool.execute({ image: 'notes.txt', ...target }, {}), /not a PNG\/JPEG\/WebP\/GIF/);
  await assert.rejects(() => tool.execute({ image: '.qq-stickers/笑死.png', ...target }, {}), /larger than 32 bytes/);
  await assert.rejects(() => tool.execute({ image: '../../etc/hostname', ...target }, {}), /inside the working directory/);
  // 一张都没发出去：校验全部发生在发消息之前。
  assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false);

  const off = await bootImages({ imageSend: false });
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  await assert.rejects(() => off.host.tools.get('qq_send_image').execute({ image: '.qq-stickers/笑死.png' }, {}), /imageSend/);
});

test('the channel prompt offers qq_send_image and lists the sticker pack', async () => {
  const on = await bootImages();
  on.onebot.push(privateMessage('在吗'));
  await until(() => on.host.list.created[0], 'the first Agent');
  const prompt = promptText(on.host, 'qq-bridge:channel');
  assert.match(prompt, /qq_send_image/);
  assert.match(prompt, /\.qq-stickers\/笑死\.png/);

  // 白名单挡掉这个工具时，提示词里一个字都不能再提它。
  const off = await bootImages(
    { allowTools: ['read'] },
    { knownTools: ['qq_send_message', 'qq_send_image', 'qq_list_conversations', 'qq_jm_pdf', 'read'] },
  );
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  const hidden = promptText(off.host, 'qq-bridge:channel');
  assert.doesNotMatch(hidden, /qq_send_image/);
  assert.doesNotMatch(hidden, /笑死\.png/);
});

test('a sticker directory outside cwd is not advertised', async () => {
  const { onebot, host } = await bootImages({ stickerDir: '../stickers' });
  onebot.push(privateMessage('在吗'));
  await until(() => host.list.created[0], 'the Agent');
  assert.ok(host.list.warnings.some((line) => line.includes('outside cwd')), host.list.warnings.join('|'));
  const prompt = promptText(host, 'qq-bridge:channel');
  // 工具照样在（发工作目录里的图不受影响），但那个读不到的目录不该被列出来。
  assert.match(prompt, /qq_send_image/);
  assert.doesNotMatch(prompt, /stickers\//);
});

// ---- 只发表情：回复正文里的 `[[图片: …]]` 标记 ---------------------------------
// 工具调用发生在整轮文字之前，而且「一个字都不说」用工具表达不出来（模型总得写点什么）。
// 所以表情写成正文里的一处标记：位置跟着正文走，整条回复只有这一处时就是一条文字都不发。

test('splitStickerLines turns sticker markers into image pieces and keeps the text order', () => {
  assert.deepEqual(splitStickerLines(''), []);
  assert.deepEqual(splitStickerLines('  \n '), []);
  assert.deepEqual(splitStickerLines('[[图片: a.png]]'), [{ kind: 'image', source: 'a.png', raw: '[[图片: a.png]]' }]);
  // 关键字写法与全角冒号、空格都认
  assert.deepEqual(splitStickerLines('[[ 表情包 ： b.gif ]]'), [{ kind: 'image', source: 'b.gif', raw: '[[ 表情包 ： b.gif ]]' }]);
  // 混在正文里也认，顺序不变
  assert.deepEqual(splitStickerLines('你好\n[[图片: a.png]]\n再见'), [
    { kind: 'text', text: '你好' },
    { kind: 'image', source: 'a.png', raw: '[[图片: a.png]]' },
    { kind: 'text', text: '再见' },
  ]);
  // 认不出来的方括号一律当普通文字：宁可在群里露出这行字，也不要静默吞掉。
  assert.deepEqual(splitStickerLines('[[图片: ]]'), [{ kind: 'text', text: '[[图片: ]]' }]);
  assert.deepEqual(splitStickerLines('[[音频: a.mp3]]'), [{ kind: 'text', text: '[[音频: a.mp3]]' }]);
});

test('a reply that is only a sticker marker sends one image and no text at all', async () => {
  // humanize 不该影响这件事：拆条拆的是文字，表情本来就只有一条。
  for (const humanize of [true, false]) {
    const { onebot, host } = await bootImages({ humanize });
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');

    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message)),
      'the sticker to reach QQ',
    );
    assert.equal(sent.params.user_id, '100000002');
    assert.equal(sent.params.message.length, 1);
    assert.equal(sent.params.message[0].type, 'image');
    assert.deepEqual(Buffer.from(sent.params.message[0].data.file.replace('base64://', ''), 'base64'), TINY_PNG);
    // 一条文字都没有：整轮只发了这一条。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(onebot.calls.filter((call) => call.action === 'send_private_msg').length, 1);
    await onebot.close();
  }
});

test('a sticker written as a bare file name is found in the sticker directory', async () => {
  // 提示词里给的是 `.qq-stickers/笑死.png`，但模型很可能只写 `笑死` 或 `笑死.png`。
  // 落空的话群里只会看到一句「表情包没发出去」，所以裸文件名先在表情包目录里找。
  for (const source of ['笑死', '笑死.png', '.qq-stickers/笑死.png']) {
    const { onebot, host } = await bootImages();
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');

    completeTurn(host, agent, `[[图片: ${source}]]`);
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message)),
      `the sticker written as ${source} to reach QQ`,
    );
    assert.equal(sent.params.message[0].type, 'image');
    assert.equal(onebot.calls.filter((call) => call.action === 'send_private_msg' && typeof call.params.message === 'string').length, 0);
    // 工具那边同一套解析。
    const viaTool = await host.tools.get('qq_send_image').execute({ image: source }, { agent });
    assert.equal(viaTool.source, '.qq-stickers/笑死.png');
    await onebot.close();
  }
});

test('a sticker marker inside a reply keeps its place between the text parts', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');

  completeTurn(host, agent, '先说我一句\n[[图片: .qq-stickers/笑死.png]]\n再补一句');
  const calls = await until(() => {
    const sent = onebot.calls.filter((call) => call.action === 'send_private_msg');
    return sent.length >= 3 ? sent : undefined;
  }, 'the three messages');
  assert.equal(calls[0].params.message, '先说我一句');
  assert.equal(calls[1].params.message[0].type, 'image');
  assert.equal(calls[2].params.message, '再补一句');
});

test('a group sticker-only reply still carries the reply target, on the image itself', async () => {
  const { onebot, host } = await bootImages({ replyStyle: 'quote' }, {}, {});
  onebot.push(mention('来一张'));
  const agent = await until(() => host.list.created[0], 'the group Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
  const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the group message');
  assert.equal(sent.params.message[0].type, 'reply');
  assert.equal(sent.params.message[0].data.id, '7000');
  assert.equal(sent.params.message[1].type, 'image');
});

test('a sticker that cannot be sent says so instead of going silent', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/nope.png]]');
  const sent = await until(
    () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('表情包没发出去')),
    'the notice to reach QQ',
  );
  assert.match(sent, /表情包没发出去/);
  // 一张图都没发出去。
  assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
  assert.ok(host.list.warnings.some((line) => line.includes('nope.png')), host.list.warnings.join('|'));
});

test('the marker stays literal text when image sending is off or whitelisted away', async () => {
  const cases = [
    { config: { imageSend: false }, hostOptions: {} },
    { config: { allowTools: ['read'] }, hostOptions: { knownTools: ['qq_send_image', 'read'] } },
  ];
  for (const { config, hostOptions } of cases) {
    const { onebot, host } = await bootImages(config, hostOptions);
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const text = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the literal line');
    assert.equal(text, '[[图片: .qq-stickers/笑死.png]]');
    assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
    assert.doesNotMatch(promptText(host, 'qq-bridge:channel'), /\[\[图片/);
  }
});

// ---- 禁漫（JM）下载 → PDF → 发到 QQ -----------------------------------------
// 这些用例把假 python 真的 spawn 起来：spawn / 协议解析 / 并发键 / 一次性 URL /
// 上传参数都是真代码，只有「下载」这一步是假的。

test('the /jm command downloads a PDF and uploads it without an Agent turn', async () => {
  const { onebot, host } = await bootJm();
  onebot.push(privateMessage('/jm 422866'));

  const texts = await until(
    () => (sentTexts(onebot, 'send_private_msg').length >= 3 ? sentTexts(onebot, 'send_private_msg') : undefined),
    'the ack / meta / done messages',
  );
  assert.match(texts[0], /收到，去下 jm422866/);
  assert.match(texts[1], /找到了：《Test Book》（2 话 · 3 页）/);
  assert.match(texts[2], /下好了/);
  // 车号是明确任务：不该为它建 Agent 会话、烧 token。
  assert.equal(host.list.created.length, 0);

  const upload = onebot.calls.find((call) => call.action === 'upload_private_file');
  assert.ok(upload, 'the PDF must be uploaded');
  assert.equal(upload.params.user_id, '100000002');
  assert.equal(upload.params.name, 'Test Book.pdf');
  assert.match(upload.params.file, /^http:\/\/127\.0\.0\.1:\d+\/f\/[0-9a-f]{32}\//);
  // NapCat 拿着这个 URL 真的能把文件拉走 —— 这是「容器里取宿主机文件」的关键一步。
  const served = await fetch(upload.params.file);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), '%PDF-1.4 fake');
});

test('a bare /jm answers with the usage instead of downloading', async () => {
  const { onebot, host } = await bootJm();
  onebot.push(privateMessage('/jm'));

  const texts = await until(
    () => (sentTexts(onebot, 'send_private_msg').length > 0 ? sentTexts(onebot, 'send_private_msg') : undefined),
    'the usage hint',
  );
  assert.match(texts[0], /用法：\/jm <车号/);
  assert.equal(onebot.calls.some((call) => call.action === 'upload_private_file'), false);
  assert.equal(host.list.created.length, 0);
});

test('an empty jmCommand lets the message through to the Agent', async () => {
  const { onebot, host } = await bootJm({ jmCommand: '' });
  onebot.push(privateMessage('/jm 422866'));

  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  assert.equal(agent.inbox[0].content[0].text, '/jm 422866');
  assert.equal(onebot.calls.some((call) => call.action === 'upload_private_file'), false);
});

test('jmDownload: false turns the command into a refusal, not a silent drop', async () => {
  const { onebot, host } = await bootJm({ jmDownload: false });
  onebot.push(privateMessage('/jm 422866'));

  const texts = await until(
    () => (sentTexts(onebot, 'send_private_msg').length > 0 ? sentTexts(onebot, 'send_private_msg') : undefined),
    'the refusal',
  );
  assert.match(texts[0], /禁漫下载没开/);
  assert.equal(host.list.created.length, 0);
});

test('the /jm command uploads a group file when it is used in a group', async () => {
  const { onebot } = await bootJm();
  onebot.push(mention('/jm 422866'));

  const upload = await until(
    () => onebot.calls.find((call) => call.action === 'upload_group_file'),
    'the group file upload',
  );
  assert.equal(upload.params.group_id, '100000001');
  assert.equal(upload.params.folder, '');
  assert.equal(upload.params.name, 'Test Book.pdf');
  assert.match(upload.params.file, /^http:\/\/127\.0\.0\.1:\d+\/f\//);
});

test('a second /jm in the same conversation is told to wait', async () => {
  const { onebot } = await bootJm({ __python: { delayMs: 1500 } });
  onebot.push(privateMessage('/jm 422866'));
  await until(
    () => sentTexts(onebot, 'send_private_msg').some((text) => /收到，去下/.test(text)),
    'the first acknowledgement',
  );
  // 等第一个任务真的登记进并发键（ack 发出与 run() 之间只差几个微任务）。
  await new Promise((resolve) => setTimeout(resolve, 150));
  onebot.push(privateMessage('/jm 413446'));

  const texts = await until(
    () => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.some((text) => /还在下上一本/.test(text)) ? list : undefined;
    },
    'the busy answer',
  );
  assert.match(texts.join('\n'), /还在下上一本/);
  // 第二个车号不该被下下来：只允许一条上传。
  await until(() => onebot.calls.some((call) => call.action === 'upload_private_file'), 'the first upload');
  assert.equal(onebot.calls.filter((call) => call.action === 'upload_private_file').length, 1);
});

test('a failed download reports the reason back to QQ', async () => {
  const { onebot } = await bootJm({ __python: { body: '这本有 146 话，超过上限 20；请指定单话' } });
  onebot.push(privateMessage('/jm 400222'));

  const texts = await until(
    () => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.some((text) => /没下成/.test(text)) ? list : undefined;
    },
    'the failure message',
  );
  assert.match(texts.join('\n'), /没下成：.*146 话/);
  assert.equal(onebot.calls.some((call) => call.action === 'upload_private_file'), false);
});

test('a PDF that cannot be uploaded is reported instead of silently lost', async () => {
  const { onebot } = await bootJm({}, {}, { uploadFails: '群文件上传需要管理员权限' });
  onebot.push(privateMessage('/jm 422866'));

  const texts = await until(
    () => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.some((text) => /文件发不出去/.test(text)) ? list : undefined;
    },
    'the upload failure message',
  );
  assert.match(texts.join('\n'), /文件发不出去：.*管理员权限/);
});

test('qq_jm_pdf sends the PDF to the QQ conversation the calling Agent belongs to', async () => {
  const { onebot, host } = await bootJm();
  onebot.push(privateMessage('帮我下这本'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent');

  const tool = host.tools.get('qq_jm_pdf');
  assert.ok(tool, 'qq_jm_pdf should be registered');
  const value = await tool.execute({ id: 'https://18comic.vip/photo/422866/' }, { agent });

  assert.equal(value.target_type, 'private');
  assert.equal(value.target_id, '100000002');
  assert.equal(value.file_name, 'Test Book.pdf');
  assert.equal(value.pages, 3);
  assert.equal(value.chapters, 2);
  assert.match(value.path, /[\\/]\.qq-jm[\\/]Test Book\.pdf$/);
  const upload = onebot.calls.find((call) => call.action === 'upload_private_file');
  assert.equal(upload.params.user_id, '100000002');
  assert.equal(upload.params.name, 'Test Book.pdf');
});

test('qq_jm_pdf needs an explicit target when no QQ conversation owns the call', async () => {
  const { onebot, host } = await bootJm();
  const tool = host.tools.get('qq_jm_pdf');

  await assert.rejects(() => tool.execute({ id: '422866' }, {}), /target_type and target_id/);
  const value = await tool.execute({ id: '422866', kind: 'chapter', target_type: 'group', target_id: '100000001' }, {});
  assert.equal(value.target_type, 'group');
  assert.equal(value.target_id, '100000001');
  const upload = onebot.calls.find((call) => call.action === 'upload_group_file');
  assert.equal(upload.params.group_id, '100000001');
  assert.equal(upload.params.name, 'Test Book.pdf');
  await assert.rejects(() => tool.execute({ id: '不是一个车号' }, {}), /could not find a JM id/);
});

test('the channel prompt offers qq_jm_pdf unless the tool whitelist hides it', async () => {
  const on = await bootJm();
  on.onebot.push(privateMessage('在吗'));
  await until(() => on.host.list.created[0], 'the first Agent');
  assert.match(promptText(on.host, 'qq-bridge:channel'), /qq_jm_pdf/);

  const off = await bootJm(
    { allowTools: ['read'] },
    { knownTools: ['qq_send_message', 'qq_list_conversations', 'qq_jm_pdf', 'read'] },
  );
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  assert.doesNotMatch(promptText(off.host, 'qq-bridge:channel'), /qq_jm_pdf/);
});

// ---- 长期记忆：转录 → 工具 → 定时摘要 -------------------------------------------------

/**
 * 起一个开了长期记忆的实例：cwd 是新的临时目录，`.qq-memory` 就落在里面。
 *
 * 默认 `digestCatchUp: false` —— 补课会在第一条消息到达时就摘要一次，用例希望自己
 * 决定什么时候触发摘要（`host.list.timers.fireInterval()`）；要验补课就显式打开。
 */
async function bootMemory(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-memory-'));
  return boot(
    { memory: true, digestCatchUp: false, readDelayMs: 0, ...config, cwd },
    hostOptions,
    onebotOptions,
  );
}

/** 距下一个本地整点还有多少毫秒（与插件 msUntilDailyHour 同一个口径）。 */
function msUntilHour(hour) {
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

/** 读 `.qq-memory/` 里的一个文件；不存在时抛错（用例里通常意味着「本该写出来」）。 */
async function readMemory(cwd, relative) {
  return readFile(join(cwd, '.qq-memory', relative), 'utf8');
}

/** 等 `.qq-memory/digest.json` 里出现某个会话的摘要记录（摘要跑完了）。 */
async function waitForDigestRecord(cwd, key) {
  return until(async () => {
    try {
      const parsed = JSON.parse(await readMemory(cwd, 'digest.json'));
      return parsed?.conversations?.[key]?.lastDigestAt ? parsed.conversations[key] : undefined;
    } catch {
      return undefined;
    }
  }, `digest.json to record ${key}`);
}

/** 本地日期（`YYYY-MM-DD`），与插件切分转录文件用的口径一致。 */
function localDateOf(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 一条入站消息落一行转录，而且**没被 @ 的群消息也算**：长期记忆的原料正是那些
 * 没人跟机器人说话的闲聊。同时验证「闲聊不会凭空建出会话记录」这条旧不变量。
 */
test('every incoming message is appended to the transcript, including ambient group chatter', async () => {
  const { onebot, host, cwd } = await bootMemory();
  onebot.push(privateMessage('第一条'));
  onebot.push(groupMessage([{ type: 'text', data: { text: '他们聊他们的' } }], { messageId: 7001, userId: 10001, card: '路人' }));
  onebot.push(mention('机器人你好'));

  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  // 转录是后台写盘（不挡事件热路径），所以这里等它落下来。目录名是 key 去掉冒号：
  // group:100000001 → group-100000001（见 memorySlug）。
  const logFile = join(cwd, '.qq-memory', 'conversations', 'private-100000002', 'log', `${localDateOf()}.jsonl`);
  await until(() => existsSync(logFile), 'the private transcript to be written');
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '第一条');
  assert.equal(lines[0].addressed, true);

  const groupLog = join(cwd, '.qq-memory', 'conversations', 'group-100000001', 'log', `${localDateOf()}.jsonl`);
  // 两条都记：一条是没人 @ 的闲聊（addressed: false），一条是被叫到的。
  // 转录是后台串行写盘的，两条不一定同一瞬间落地，所以这里等它写全再看内容。
  const groupLines = await until(async () => {
    if (!existsSync(groupLog)) return undefined;
    const parsed = (await readFile(groupLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return parsed.length >= 2 ? parsed : undefined;
  }, 'both group messages to be written to the transcript');
  assert.deepEqual(groupLines.map((line) => line.addressed), [false, true]);
  assert.equal(groupLines[0].name, '路人');

  // 旧的硬约束不变量：没被 @ 的群消息不该让这个群出现在「处理过的会话」表里。
  const list = await host.tools.get('qq_list_conversations').execute({}, {});
  assert.deepEqual(list.sessions.map((session) => session.conversation), ['private:100000002', 'group:100000001']);
  assert.equal(agent.id, list.sessions[0].session_id);
});

/** qq_transcript 的 list / read / search 三个动作，以及「默认就是当前会话」。 */
test('qq_transcript lists conversations and reads and searches their records', async () => {
  const { onebot, host } = await bootMemory();
  onebot.push(privateMessage('周六去看那个展吗'));
  onebot.push(privateMessage('展叫什么来着'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  const tool = host.tools.get('qq_transcript');
  assert.ok(tool, 'qq_transcript should be registered');
  // 等两条都进转录（第二条提交后才算完一轮，但转录是先写的）。
  await until(async () => {
    const value = await tool.execute({ action: 'read' }, { agent });
    return value.returned >= 2 ? value : undefined;
  }, 'both private messages to be recorded');

  const listed = await tool.execute({ action: 'list' }, {});
  assert.equal(listed.lines.length, 1);
  assert.equal(listed.lines[0].conversation, 'private:100000002');
  assert.equal(listed.lines[0].messages, 2);

  // 不传 conversation 时默认就是调用它的那个 Agent 的会话。
  const read = await tool.execute({ action: 'read', limit: 1 }, { agent });
  assert.equal(read.returned, 1);
  assert.equal(read.truncated, true);
  assert.equal(read.lines[0].text, '展叫什么来着');
  assert.equal(read.lines[0].user, 'iroha');

  const found = await tool.execute({ action: 'search', query: '展' }, { agent });
  assert.equal(found.returned, 2);
  const missing = await tool.execute({ action: 'search', query: '不存在的词' }, { agent });
  assert.equal(missing.returned, 0);
  await assert.rejects(() => tool.execute({ action: 'search' }, { agent }), /"query" is required/);
});

/** qq_memory：追加、读回、覆盖，以及「写不出记忆目录」这条边界。 */
test('qq_memory appends, reads back and overwrites, and refuses paths outside the memory directory', async () => {
  const { onebot, host, cwd } = await bootMemory();
  onebot.push(privateMessage('你好'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  const tool = host.tools.get('qq_memory');
  assert.ok(tool, 'qq_memory should be registered');

  const target = 'conversations/group-100000001/MEMORY.md';
  const written = await tool.execute({ action: 'append', path: target, text: '- 群主叫kaguya，周六常组织打本' }, {});
  assert.equal(written.action, 'append');
  assert.match(await readMemory(cwd, target), /群主叫kaguya/);

  await tool.execute({ action: 'append', path: target, text: '- 群里不喜欢被叫「大佬」' }, {});
  const read = await tool.execute({ action: 'read', path: target }, {});
  assert.match(read.text, /群主叫kaguya/);
  assert.match(read.text, /不喜欢被叫/);
  assert.match(read.text, /^\s+1 \| /m, 'read should number the lines');

  const overwritten = await tool.execute({ action: 'write', path: target, text: '- 只留这一条' }, {});
  assert.equal(overwritten.action, 'write');
  assert.doesNotMatch(await readMemory(cwd, target), /群主叫kaguya/);

  const found = await tool.execute({ action: 'search', path: target, query: '只留' }, {});
  assert.equal(found.returned, 1);

  const files = await tool.execute({ action: 'list' }, {});
  assert.ok(files.files.some((file) => file.endsWith(target)), 'list should show the memory file');

  // 边界：绝对路径、`..`、以及写到记忆目录之外都必须被拒 —— 记忆工具是宿主平面的，
  // QQ 消息是拿不到它的，但摘要 Agent 会照着模型输出的路径写，路径必须由插件说了算。
  await assert.rejects(() => tool.execute({ action: 'write', path: '../evil.md', text: 'x' }, {}), /not inside the memory directory/);
  await assert.rejects(() => tool.execute({ action: 'write', path: '/tmp/evil.md', text: 'x' }, {}), /not inside the memory directory/);
  assert.equal(existsSync(join(cwd, 'evil.md')), false);
});

/** 定时器每天醒一次（默认 04:00），醒来帮会话摘要一次并记下进度。 */
test('a digest sweep summarizes a conversation that has something new', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 2 });
  onebot.push(privateMessage('第一条'));
  onebot.push(privateMessage('第二条'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');

  // 定时器是每天一次的「下一个 04:00」：不是固定周期，所以间隔必须落在
  // (0, 24h] 里，且大致等于「距下一个整点还有多久」。
  const intervals = host.list.timers.live('intervals');
  assert.equal(intervals.length, 1, 'the daily digest timer should be registered');
  const armed = intervals[0].delay;
  assert.ok(armed > 0 && armed <= 24 * 60 * 60 * 1000, `delay should be within a day, got ${armed}`);
  assert.ok(Math.abs(armed - msUntilHour(4)) < 5000, `delay should point at the next 04:00, got ${armed}`);

  host.list.timers.fireInterval();

  const record = await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(record.lastLines, 2);
  assert.equal(record.lastDigestDate, localDateOf(), 'the digest should be recorded under today\'s date');

  // 摘要 Agent 是一个**独立会话**（不是那个正在聊天的会话），它拿到的正文是转录窗口。
  const digestAgent = host.list.created.find((agent) => agent.id !== host.list.created[0].id);
  assert.ok(digestAgent, 'a separate digest session should have been created');
  const instruction = digestAgent.inbox[digestAgent.inbox.length - 1].content[0].text;
  assert.match(instruction, /private:100000002/);
  assert.match(instruction, /第一条/);
  assert.match(instruction, /第二条/);

  // 摘要会话的系统提示点明它是后台记忆维护会话，并指定了要处理的会话。
  const digestPromptText = promptText(host, 'qq-bridge:digest');
  assert.match(digestPromptText, /记忆维护会话/);
  assert.match(digestPromptText, /message-digest/);

  // 一天至多一次：即使定时器又醒一次、这期间又来了两条（远超 digestMinLines），
  // 同一个会话今天也不该再被摘要一遍。
  onebot.push(privateMessage('第三条'));
  onebot.push(privateMessage('第四条'));
  await settle(80);
  const before = await readMemory(cwd, 'digest.json');
  const digests = host.list.created.length;
  host.list.timers.fireInterval();
  await settle(200);
  assert.equal(await readMemory(cwd, 'digest.json'), before);
  assert.equal(host.list.created.length, digests, 'a conversation is digested at most once a day');
});

/** 消息太少时不该白跑一次模型调用 —— 留到明天，什么都不写。 */
test('a digest sweep leaves a quiet conversation for later', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 20 });
  onebot.push(privateMessage('就一句'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  host.list.timers.fireInterval();
  await settle(200);
  assert.equal(host.list.created.length, 1, 'no digest session should be created for a single message');
  // 没攒够就什么都不记（连 digest.json 都不该出现），明天再看 —— 消息不会丢，
  // dirty 计数一直在。
  assert.equal(existsSync(join(cwd, '.qq-memory', 'digest.json')), false);
});

/**
 * 错过了摘要点就补课：进程在 04:00 那一刻没跑（重启了），重启后第一个说话的人
 * 一开口就把这条会话补摘要一次 —— 而不是等到明天。
 *
 * 这里把 `digestAtHour` 设成 0（今天必然已经过了这个点），于是「补课」是确定性的，
 * 不依赖测试在一天里的哪个时刻跑。
 */
test('a conversation that missed the digest hour is caught up on its next message', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  onebot.push(privateMessage('重启之后的第一句'));
  await until(() => host.list.created.length > 1, 'the catch-up digest session to be created')
    .catch((error) => {
      throw new Error(`${error.message} | created=${host.list.created.length} warnings=${JSON.stringify(host.list.warnings)} timers=${host.list.timers.live('intervals').length} tools=${[...host.tools.keys()].join(',')}`);
    });
  const record = await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(record.lastDigestDate, localDateOf(), 'the catch-up should be recorded under today');
  assert.equal(record.lastLines, 1);
});

/** 补课是每次启动一轮，不是每条消息一轮。 */
test('the catch-up sweep runs once per process, not once per message', async () => {
  const { onebot, host } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  onebot.push(privateMessage('第一句'));
  await until(() => host.list.created.length > 1, 'the first catch-up digest');
  const after = host.list.created.length;
  onebot.push(privateMessage('第二句'));
  await settle(200);
  assert.equal(host.list.created.length, after, 'no second digest session should be created');
});

/** 关掉 digestCatchUp 时，错过摘要点就只在明天的点上摘要。 */
test('digestCatchUp: false leaves a missed digest until the next daily run', async () => {
  const { onebot, host } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: false });
  onebot.push(privateMessage('今天不补'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  await settle(200);
  assert.equal(host.list.created.length, 1, 'no digest session without a timer tick');
});

/** 索引 + 本会话记忆会出现在渠道提示里，好让模型「知道自己记得什么」。 */
test('the channel prompt carries the memory index once it exists', async () => {
  const { onebot, host, cwd } = await bootMemory();
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });
  await writeFile(join(cwd, '.qq-memory', 'INDEX.md'), '- kaguya：群主，周六常组织打本', 'utf8');
  onebot.push(privateMessage('在吗'));
  await until(() => host.list.created[0], 'the first Agent');
  // 索引是异步刷新进缓存的（提示词装配是同步的），所以第一次装配可能还是空的。
  const text = await until(() => {
    const current = promptText(host, 'qq-bridge:channel');
    return current.includes('群主，周六常组织打本') ? current : undefined;
  }, 'the memory index to reach the channel prompt');
  assert.match(text, /长期记忆的索引/);
});

/** memoryDir 配到 cwd 外面时整个功能停用（与 mediaDir / stickerDir / jmDir 一致）。 */
test('memory is disabled when memoryDir leaves cwd', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'qq-bridge-outside-'));
  const { onebot, host } = await bootMemory({ memoryDir: join(outside, 'memory') });
  onebot.push(privateMessage('你好'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  assert.equal(host.tools.get('qq_transcript'), undefined);
  assert.equal(host.tools.get('qq_memory'), undefined);
  assert.equal(host.list.timers.live('intervals').length, 0);
  assert.ok(
    host.list.warnings.some((warning) => warning.includes('resolves outside cwd')),
    `expected a warning, got: ${host.list.warnings.join(' | ')}`,
  );
});

/**
 * 摘要卡住时不能把摘要永久堵死：硬超时到点就销毁那个 Agent，下次重新开一个。
 *
 * 这里让 `whenIdle()` 永不 resolve（模拟一个卡死的模型请求），然后手动让超时守卫醒来。
 */
test('a digest that never goes idle is given up on and cleaned up', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 1 });
  // 让这个实例的每个 Agent 都「永不结束这一轮」。
  host.list.stallIdle = true;
  onebot.push(privateMessage('帮我看个东西'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  host.list.timers.fireInterval();
  await until(() => host.list.timers.live('timeouts').length > 0, 'the digest timeout guard to be armed');

  host.list.timers.fireTimeout();
  await until(
    () => host.list.warnings.some((warning) => warning.includes('timed out')),
    'the digest to report its timeout',
  );
  await settle(80);
  // 超时的这次不算数：状态里不该留下 lastDigestAt（下一轮还会再试），而被销毁的
  // 摘要 Agent 已经不在 ctx.agents 里了。
  const state = await readMemory(cwd, 'digest.json').then((text) => JSON.parse(text)).catch(() => ({ conversations: {} }));
  assert.equal(state.conversations['private:100000002']?.lastDigestAt, undefined);
  const digestAgent = host.list.created[1];
  assert.ok(digestAgent, 'the digest session should have been created');
  assert.equal(host.ctx.agents.get(digestAgent.id), undefined, 'the stuck digest agent should have been disposed');
});

// ---- 主动说话：不等 @ 自己开个话头 -----------------------------------------------------

/**
 * 起一个开了主动说话的实例。
 *
 * 闸门默认全部放宽（概率 1、不必等安静、不限新旧、不限间隔），时段设成「全天」
 * （`from === to`）—— 用例因此不必关心自己跑在一天里的哪个时刻；要验哪道闸门就
 * 自己把它收紧。
 *
 * `digestMinLines` 抬到很高，是因为 `fireInterval()` 会唤醒**所有**周期定时器：
 * 不设这一条，摘要循环可能被顺带跑起来、凭空多出一个摘要会话。
 */
async function bootProactive(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-'));
  return boot(
    {
      proactive: true,
      proactiveChance: 1,
      proactiveIdleMs: 0,
      proactiveFreshMs: 0,
      proactiveGapMs: 0,
      proactiveDailyMax: 4,
      proactiveFromHour: 0,
      proactiveToHour: 0,
      digestCatchUp: false,
      digestMinLines: 9999,
      ...config,
      cwd,
    },
    hostOptions,
    onebotOptions,
  );
}

/**
 * 让机器人在群里被 @ 一次并回一句：会话因此建立，`lastBotSpeakAt` 也有值。
 *
 * 末尾多等一小会儿是必要的：`lastBotSpeakAt` 是在 `sendOne` 拿到 OneBot 响应之后才
 * 记上的，而 `sentTexts()` 看到的是服务端**收到**请求的那一刻 —— 两者之间有一个
 * 往返的窗口，不等就可能带着过期的「我最后说话的时间」去判主动说话。
 */
async function groupWhereBotSpoke(onebot, host, botReply = '在的') {
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the first turn to be submitted');
  completeTurn(host, agent, botReply);
  await until(() => sentTexts(onebot).length >= 1, 'the first reply to go out');
  await settle(30);
  return agent;
}

/** 一个路人在群里说一句（没 @ 机器人）—— 「群里还有人说话」的信号。 */
async function groupChatter(onebot, text = '今晚吃啥', { messageId = 7001 } = {}) {
  onebot.push(groupText(text, { messageId, userId: 10001, card: '路人' }));
  await settle(80);
}

/** 主动说话的可选边界：左闭右开、两边相等 = 全天、from > to = 跨零点。 */
test('withinActiveHours is half-open, all-day when equal, and wraps midnight', () => {
  assert.equal(withinActiveHours(9, 23, 9), true);
  assert.equal(withinActiveHours(9, 23, 22), true);
  assert.equal(withinActiveHours(9, 23, 23), false, 'the end hour is exclusive');
  assert.equal(withinActiveHours(9, 23, 3), false, 'the small hours are quiet');
  assert.equal(withinActiveHours(22, 3, 23), true, 'a window may wrap midnight');
  assert.equal(withinActiveHours(22, 3, 2), true);
  assert.equal(withinActiveHours(22, 3, 3), false);
  assert.equal(withinActiveHours(22, 3, 12), false);
  assert.equal(withinActiveHours(23, 0, 23), true);
  assert.equal(withinActiveHours(0, 0, 4), true, 'from === to means all day');
});

/** 主动说话：群里安静下来之后真的冒一句，而且走的是同一条拟人通道。 */
test('proactive: the bot speaks up once a group has gone quiet, on the humanized path', async () => {
  const { onebot, host } = await bootProactive();
  const agent = await groupWhereBotSpoke(onebot, host);

  // 它刚说完、之后没人接话：这时候再自己开口就是独白（真人也不会对着空群自说自话）。
  host.list.timers.fireInterval();
  await settle(120);
  assert.equal(agent.inbox.length, 1, 'the bot must not monologue after its own reply');
  assert.equal(sentTexts(onebot).length, 1);

  // 路人的一句话之后才轮到它：这一轮是插件伪造的 user message，不是谁在跟它说话。
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'a proactive turn to be submitted');
  const nudge = agent.inbox[agent.inbox.length - 1].content[0].text;
  assert.match(nudge, /不是谁发给你的消息/);
  assert.match(nudge, /SKIP/);
  assert.match(nudge, /已经安静了大约 \d+ 分钟/);
  // 群里刚说过的话在渠道提示里 —— 有上下文才可能接得上话。
  assert.match(promptText(host, 'qq-bridge:channel'), /今晚吃啥/);

  // 回复照常按「换行 = 分条」发出去，说明主动搭话用的是拟人通道而不是一条整段。
  completeTurn(host, agent, '随便点个外卖吧\n你吃啥', 2);
  await until(() => sentTexts(onebot).length === 3, 'the proactive messages to go out');
  assert.deepEqual(sentTexts(onebot).slice(1), ['随便点个外卖吧', '你吃啥']);
});

/** 主动说话：判成 SKIP 就一个字都不发，但这次机会照样用掉。 */
test('proactive: SKIP keeps the group silent yet still spends the chance', async () => {
  const { onebot, host } = await bootProactive({ proactiveGapMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'a proactive turn to be submitted');
  // 后面那半句「解释」也不该发出去：模型只是在说明自己的决定。
  completeTurn(host, agent, 'SKIP（没什么可说的）', 2);
  await settle(150);
  assert.equal(sentTexts(onebot).length, 1, 'SKIP must not be sent to the group');

  // 又一次「有人说话」把机会递到眼前：刚掷中过（虽然没说），间隔闸必须拦住 ——
  // 否则 SKIP 会变成「再来一次」，每检查一次就掷一回骰子。
  await groupChatter(onebot, '还在吗', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'a skipped nudge still counts against the gap');
  assert.equal(sentTexts(onebot).length, 1);
});

/** 主动说话默认关闭：连定时器都不挂，更不会开口。 */
test('proactive is off by default: no timer, and no unprompted message', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-off-'));
  const { onebot, host } = await boot({
    cwd,
    // 除了开关，其它条件全部调成「一定会说」；它仍然不该开口。
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
  });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  // 记忆的每日摘要定时器挂着（memory 默认开），但没有主动说话的定时器。
  assert.equal(host.list.timers.live('intervals').length, 1, 'only the daily digest timer should be registered');
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'without proactive the bot never speaks first');
  assert.equal(sentTexts(onebot).length, 1);
});

/** 主动说话只在群里发生：私聊对象是真人和机器人之间的对话，不该被无端戳一下。 */
test('proactive never messages a private chat', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-private-'));
  const { onebot, host } = await boot({
    cwd,
    proactive: true,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFreshMs: 0,
    proactiveGapMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the private turn');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the private reply');
  // 对方又发了一句，而这一轮模型没话可说（没有消息发回去）—— 于是这个私聊会话正好停在
  // 「最后说话的是对方」这个状态上：换成群，它就会进入主动说话的候选。
  onebot.push(privateMessage('你忙不'));
  await until(() => agent.inbox.length >= 2, 'the second private message to be submitted');
  completeTurn(host, agent, '', 2);
  await settle(80);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'private chats are never nudged by the plugin');
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1);
});

/** 时段闸：不在配置的「清醒时段」里就一声不吭（真人半夜不会突然冒泡）。 */
test('proactive stays inside the configured hours', async () => {
  // 挑一个必然不含当前小时的两小时窗口：+2 → +3。
  const hour = new Date().getHours();
  const { onebot, host } = await bootProactive({
    proactiveFromHour: (hour + 2) % 24,
    proactiveToHour: (hour + 3) % 24,
  });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'outside the waking hours the bot stays quiet');
});

/** 安静时长闸：群里还在聊的时候不插嘴。 */
test('proactive leaves a group alone while it is still talking', async () => {
  const { onebot, host } = await bootProactive({ proactiveIdleMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a group that just spoke is not the bot\'s turn');
});

/** 新鲜度闸：好几天没人说话的冷群不会突然诈尸。 */
test('proactive does not resurrect a group that has been quiet for too long', async () => {
  const { onebot, host } = await bootProactive({ proactiveFreshMs: 1 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a stale group should not suddenly hear from the bot');
});

/** 每日上限：同一个群一天说够了就不再开口，哪怕又有人接话。 */
test('proactive respects the daily cap per group', async () => {
  const { onebot, host } = await bootProactive({ proactiveDailyMax: 1 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the first proactive turn');
  completeTurn(host, agent, '外卖吧', 2);
  await until(() => sentTexts(onebot).length >= 2, 'the first proactive message');

  // 又有人说话、安静时长与间隔都满足，但今天这个群的额度用完了。
  await groupChatter(onebot, '你们在干嘛', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the daily cap should stop a second nudge');
});

/** 主动搭话出错时不道歉：没人问过它，平白多一句「我这边出错了」只是噪音。 */
test('a proactive turn that errors stays silent instead of apologising', async () => {
  const { onebot, host } = await bootProactive();
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the proactive turn');
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[agent.inbox.length - 1], turn: 2 });
  host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } });
  await settle(150);
  assert.equal(sentTexts(onebot).length, 1, 'nobody asked the bot anything, so it must not apologise');
});

/** `/reset` 连主动说话的节奏一起忘掉：刚清空完不该还被「两小时前主动说过」挡着。 */
test('proactive forgets its own pacing when the conversation is reset', async () => {
  const { onebot, host } = await bootProactive({ proactiveGapMs: 60 * 60 * 1000 });
  const agent = await groupWhereBotSpoke(onebot, host);
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'the first proactive turn');
  completeTurn(host, agent, '外卖吧', 2);
  await until(() => sentTexts(onebot).length >= 2, 'the proactive message');
  // 间隔闸生效：刚主动说完，下一句就不该再说。
  await groupChatter(onebot, '话说回来', { messageId: 7002 });
  host.list.timers.fireInterval();
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the gap should hold before the reset');

  // 清空会话：确认消息也是一句「机器人说的话」，于是还得等群里有人接一句才轮到它。
  // 群聊的 /reset 得 @ 它（默认 groupTrigger: mention），所以这里用 mention。
  onebot.push(mention('/reset'));
  await until(() => sentTexts(onebot).some((text) => String(text).includes('已清空')), 'the reset confirmation');
  await groupChatter(onebot, '那继续吧', { messageId: 7004 });
  host.list.timers.fireInterval();
  // 会话真的被重建了：旧 Agent 被销毁，主动搭话投给了新造的那个 Agent。
  const fresh = await until(() => host.list.created[1], 'a fresh Agent for the proactive turn');
  assert.equal(fresh.inbox.length, 1);
  assert.match(fresh.inbox[0].content[0].text, /不是谁发给你的消息/);
  assert.ok(host.list.disposed.length >= 1, 'the reset should have disposed the old Agent');
  assert.equal(agent.inbox.length, 2, 'the disposed Agent gets nothing more');
});


// ---- 活跃对话：聊起来之后保持搭话 -------------------------------------------------------

/**
 * 起一个「活跃对话」实例。
 *
 * A（免 @ 接话）默认开着；B（补一句）默认关（`activeChimeIdleMs: 0`），要验它的用例自己
 * 打开并把静默门槛压到几十毫秒 —— 默认值是 20 秒，用例不可能真等。`delayJitter: 0` 用来
 * 把补一句的延迟钉死，不然它是 20 秒 ± 40%。
 */
async function bootActive(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-active-'));
  return boot(
    {
      activeFollow: true,
      activeChimeIdleMs: 0,
      delayJitter: 0,
      // 冷场主动开口那一套在这里没有意义（用例不会去 fireInterval），但把概率钉成 1
      // 可以让「补一句」这条路的随机性不影响断言。
      proactiveChance: 1,
      digestCatchUp: false,
      digestMinLines: 9999,
      ...config,
      cwd,
    },
    hostOptions,
    onebotOptions,
  );
}

/** `mentionsOthers` 只认指向**别人**的 at 段（`at all` 也算别人，空 qq 不算）。 */
test('mentionsOthers sees at-segments aimed at somebody else', () => {
  const at = (qq) => ({ type: 'at', data: { qq } });
  const text = (value) => ({ type: 'text', data: { text: value } });
  assert.equal(mentionsOthers([text('你好')], SELF_ID), false);
  assert.equal(mentionsOthers([at(SELF_ID), text('你好')], SELF_ID), false);
  assert.equal(mentionsOthers([at('10001'), text('你看')], SELF_ID), true);
  assert.equal(mentionsOthers([at('all'), text('大家看')], SELF_ID), true);
  assert.equal(mentionsOthers([at(''), text('空')], SELF_ID), false);
  assert.equal(mentionsOthers('纯字符串没有段', SELF_ID), false);
});

/** A：跟它聊的那个人接着说的话，不用再 @ 一次。 */
test('activeFollow: the person it was talking to can keep talking without another @', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着说，没有 @：窗口里算「接着聊」。
  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up to be admitted without a mention');
  assert.equal(agent.inbox[1].content[0].text, '那你说呢');

  // 别人插一句不算：他没在跟它聊（闲聊也不该因此进 Agent）。
  onebot.push(groupText('我先走了', { messageId: 7002, userId: 10001, card: '路人' }));
  await settle(60);
  assert.equal(agent.inbox.length, 2, 'a different person is not part of the exchange');
});

/** A：默认关闭 —— 它放松的是「群里只在被 @ 时才说话」这条默认约定。 */
test('activeFollow is off by default, so a group reply still needs a mention', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-active-off-'));
  const { onebot, host } = await boot({ cwd, digestCatchUp: false, digestMinLines: 9999 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'without activeFollow the @ requirement still holds');
});

/** A：中间有别人说话，这次「你跟我聊」就算断了。 */
test('activeFollow: a third party speaking in between ends the exchange', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('你们聊', { messageId: 7001, userId: 10001, card: '路人' }));
  await settle(60);
  onebot.push(groupText('那你说呢', { messageId: 7002 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'the exchange is over once someone else speaks');
});

/** A：@ 别人（或 @ 全体）的那句不是跟它说的。 */
test('activeFollow: a message that mentions somebody else is not a follow-up', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupMessage([
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: '你怎么看' } },
  ], { messageId: 7001 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'a message aimed at somebody else must be left alone');
});

/** A：一次活跃对话里免 @ 接的轮数有上限（`activeMaxTurns`）。 */
test('activeFollow: activeMaxTurns limits how long it keeps following', async () => {
  const { onebot, host } = await bootActive({ activeMaxTurns: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the first follow-up');
  completeTurn(host, agent, '我觉得行', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  onebot.push(groupText('还有呢', { messageId: 7002 }));
  await settle(80);
  assert.equal(agent.inbox.length, 2, 'the cap should force a fresh mention');
});

/** A：窗口过期之后又得重新 @ 它。 */
test('activeFollow: the window expires', async () => {
  // 窗口 1 毫秒：下一条消息到的时候必然已经过期 —— 不依赖用例跑多久。
  const { onebot, host } = await bootActive({ activeWindowMs: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'an expired window means a mention is needed again');
});

/** A：窗口跟着「最后被叫到的那个人」走。 */
test('activeFollow: the window follows whoever spoke to it last', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the first mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 路人 也 @ 它：窗口换到 路人 身上。
  onebot.push(mention('我也问一句', { userId: 10001, card: '路人', messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the second mention');
  completeTurn(host, agent, '你说', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  onebot.push(groupText('那然后呢', { messageId: 7002, userId: 10001, card: '路人' }));
  await until(() => agent.inbox.length >= 3, 'the new speaker may continue');
  // 最早那个人回来了，但他已经不在窗口里。
  onebot.push(groupText('（我问的）', { messageId: 7003 }));
  await settle(80);
  assert.equal(agent.inbox.length, 3, 'only the latest speaker is inside the window');
});

/** A：前缀模式下接上的那句不能按前缀长度硬切（「然后呢」不该变成「后呢」）。 */
test('activeFollow: a followed message keeps its text intact in prefix mode', async () => {
  const { onebot, host } = await bootActive({ groupTrigger: 'prefix' });
  onebot.push(groupText('/你好'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the prefixed message');
  assert.equal(agent.inbox[0].content[0].text, '你好');
  completeTurn(host, agent, '你好呀', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('然后呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up');
  assert.equal(agent.inbox[1].content[0].text, '然后呢');
});

/** B：它回完之后对方安静一小会儿，它可能再补一句 —— 私聊也可以。 */
test('activeChime: it adds one more line into the lull after its reply', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 30 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // 私聊里没有 @ 这回事：回完之后对方安静下来，它自己再投一条「补一句」的提醒。
  await until(() => agent.inbox.length >= 2, 'the follow-up turn to be submitted');
  const nudge = agent.inbox[1].content[0].text;
  assert.match(nudge, /你已经回过话/);
  assert.match(nudge, /SKIP/);
  // 投放它的时候没有在跟谁说话，所以不挂引用。
  completeTurn(host, agent, '对了，你上次说的那个展去了吗', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up to go out');
  assert.equal(sentTexts(onebot, 'send_private_msg')[1], '对了，你上次说的那个展去了吗');

  // 不会连珠炮：对方每说一句之后最多补一句。
  await settle(150);
  assert.equal(agent.inbox.length, 2, 'the bot must not keep talking into the void');
});

/** B：判成 SKIP 就一个字都不发。 */
test('activeChime: a SKIP keeps the lull silent', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 30 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  await until(() => agent.inbox.length >= 2, 'the follow-up turn');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1, 'SKIP must not be sent');
});

/** B：没有 proactive 这个总开关就不补 —— 它是「允许主动发消息」的唯一开关。 */
test('activeChime needs the proactive master switch', async () => {
  const { onebot, host } = await bootActive({ activeChimeIdleMs: 30 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  await settle(200);
  assert.equal(agent.inbox.length, 1, 'without proactive nothing is sent unprompted');
});

/** B：群里中间有人插话时不要硬补一句（那会儿话头已经不是它的了）。 */
test('activeChime: somebody else speaking first keeps the bot from chiming in', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 40 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 它正准备补一句的时候，群里别人先说话了 → 不插嘴。
  onebot.push(groupText('那我先撤了', { messageId: 7001, userId: 10001, card: '路人' }));
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'a third party breaks the lull');
});

/** B：群里没人插话时，补一句照常发生（用户能看见的那条通路）。 */
test('activeChime: in a group it adds its line when nobody else speaks', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 40 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await until(() => agent.inbox.length >= 2, 'the follow-up turn to be submitted');
  assert.match(agent.inbox[1].content[0].text, /你已经回过话/);
  completeTurn(host, agent, '对了，你昨天那个事怎么样了', 2);
  await until(() => sentTexts(onebot).length === 2, 'the follow-up to go out');
  assert.equal(sentTexts(onebot)[1], '对了，你昨天那个事怎么样了');
});

/** B：对方再说话会把挂着的「补一句」作废（一条消息只对应一次机会）。 */
test('activeChime: a new message from the other side cancels the pending follow-up', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 60 });
  onebot.push(privateMessage('第一句'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '回第一句', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 补一句的定时器还没醒（60 毫秒），对方又说话了：那个定时器作废，只按新消息再排一个。
  onebot.push(privateMessage('第二句'));
  await until(() => agent.inbox.length >= 2, 'the second message');
  completeTurn(host, agent, '回第二句', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the second reply');

  await until(() => agent.inbox.length >= 3, 'exactly one follow-up turn');
  await settle(200);
  assert.equal(agent.inbox.length, 3, 'the stale timer must not add a second follow-up');
});

/** B：单会话每天的补一句额度用完了就不再补。 */
test('activeChime: activeChimeDailyMax caps the day', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    activeChimeIdleMs: 30,
    activeChimeMax: 5,
    activeChimeDailyMax: 1,
  });
  onebot.push(privateMessage('第一句'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '回第一句', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 第一次补一句用掉了当天的额度。
  await until(() => agent.inbox.length >= 2, 'the first follow-up turn');
  completeTurn(host, agent, '补的第一句', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up');

  // 对方又说话、它又回：这一轮不该再补。
  onebot.push(privateMessage('第三句'));
  await until(() => agent.inbox.length >= 3, 'the third message');
  completeTurn(host, agent, '回第三句', 3);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 3, 'the third reply');
  await settle(200);
  assert.equal(agent.inbox.length, 3, 'the daily chime budget is spent');
});

/** `/reset` 会把「还聊着」也忘掉：清空之后不会再补一句。 */
test('/reset forgets the active exchange as well', async () => {
  const { onebot, host } = await bootActive({ proactive: true, activeChimeIdleMs: 40 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // 补一句还没醒就 /reset：窗口与定时器一起没了。
  onebot.push(privateMessage('/reset'));
  await until(() => sentTexts(onebot, 'send_private_msg').some((text) => String(text).includes('已清空')), 'the reset confirmation');
  await settle(200);
  // 补一句若真的醒了，它会开一轮新 turn —— 那必然要新建一个 Agent（旧的刚被销毁）。
  // 所以「没有第二个 Agent」就是「那个定时器确实被作废了」的最强证据。
  assert.equal(host.list.created.length, 1, 'the cancelled chime must not open a turn after the reset');
});

/** 活跃对话里接上的一句只是闲聊，不是指令：`/reset` 得明确叫它才算。 */
test('activeFollow: a followed message never triggers a command bypass', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 窗口内同一句话没有 @：它被当成闲聊交给 Agent，而不是当作 /reset 执行。
  onebot.push(groupText('/reset', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the followed message to reach the Agent');
  assert.equal(agent.inbox[1].content[0].text, '/reset');
  await settle(80);
  assert.ok(!sentTexts(onebot).some((text) => String(text).includes('已清空')), 'the window must not run commands');
});
