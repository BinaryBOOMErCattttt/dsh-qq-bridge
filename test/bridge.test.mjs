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
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import yaml from 'js-yaml';
import { Config, apply, inject, liveConfig, parseApiKeyPool, sessionIdFor, withinActiveHours } from '../index.js';
import { blankMessageLabel, collectMedia, isEmojiOnlyMessage, isStickerSegment, mediaLabel, mediaPlaceholder, mentionsOthers, messageToText, repeatableText, splitBurst, splitStickerLines, typingDelayMs } from '../onebot.js';
import { createMediaStore, sniffImageExtension } from '../media.js';
import { REMINDER_ROUTE_PATH } from '../reminders.js';
import { imageSegment, loadOutgoingImage } from '../image.js';
import { OTHER_PNG, PIC_JPEG, PIC_PNG } from './image-fixtures.mjs';

/** 插件默认的 `allowTools`（只读文件 + 检索 + 联网 + 七个 qq_*）：默认值的契约。 */
const DEFAULT_ALLOW_TOOLS = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'skill',
  'qq_memory',
  'qq_transcript',
  'qq_send_message',
  'qq_send_image',
  'qq_save_sticker',
  'qq_rename_sticker',
  'qq_list_conversations',
  'qq_poke',
];

/** 测试用机器人自己的 QQ 号。 */
const SELF_ID = 100000000;
/** 私聊测试里的发送者（`privateMessage` 用的就是它）。 */
const PRIVATE_USER_ID = 100000002;
/** 群聊测试里的默认发言者（`groupMessage` 用的就是它）。 */
const GROUP_USER_ID = 100000003;

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
  /**
   * 让前 N 次 `ctx.get('agentPresets')` 返回 undefined，模拟启动竞态：预设平面还没
   * active，而第一条 QQ 消息已经到了。见 index.js 的 `attachAgentPreset`。
   */
  presetSetupFailures = 0,
  /**
   * `ctx.get('credentials')` 的桩：API key 轮换用它读写 `$DSH_HOME/.credentials.yaml`
   * （见下面的 `fakeCredentials`）。不传 = 组合里没有凭据服务。
   */
  credentials,
  /**
   * `ctx.get('connection')` 的桩：设置页的定时任务列表挂在 Connection 的认证
   * 栅栏内（`connection.fetch.register`）。不传 = 这个组合没有 Web 半侧。
   *
   * 注意它与真宿主的时序差别：真组合里 `dsh-client-connection` 是在插件 apply
   * **之后**（网页起来那会儿）才 provide 这个服务的，所以插件必须用 `ctx.inject`
   * 等它 —— 想要复现那段时序，别传这里，改用 `host.list.provide('connection', …)`。
   */
  connection,
  /** 真实宿主的 cordis LoggerService 门面带 exporter()；带上它插件会额外镜像一份到 stderr。 */
  loggerExporter = false,
  /**
   * `ctx.fiber` 的桩：插件在配置热更新（`loader/volatile-update`）之后会调
   * `ctx.fiber.restart()` 重启自己。不传 = 最小组合里没有 fiber（插件只记一条 warn）。
   */
  fiber,
  /**
   * 让前 N 次 `agentCtx.get('systemPrompt')` 返回 undefined，模拟真宿主的竞态：
   * `ctx.get()` 是 strict 的，服务 fiber 还没 active 时就是拿不到。Agent 的 resume 可能
   * 赶在服务 active 之前（真实事故：19:48 那次 resume 之后渠道提示整段丢了）。
   */
  promptSetupFailures = 0,
} = {}) {
  const listeners = new Map();
  const tools = new Map();
  const agents = new Map();
  const prompts = [];
  const created = [];
  const warnings = [];
  /** 所有 info 日志（轮换成功／没配置时的自述都在这一级）—— 用来验「key 没被整条打出来」。 */
  const infos = [];
  const disposers = [];
  /** `systemPrompt` 还剩几次「服务不可见」；见 makeHost 的 promptSetupFailures。 */
  let promptFailuresLeft = promptSetupFailures;
  /**
   * 假 `systemPrompt` 服务：注册时把条目推进 `prompts`，返回的 disposer 能撤销。
   *
   * disposer 是必须的：插件在补挂渠道小节前会先撤上一份（同名注册会抛 duplicate），
   * 没有撤销能力的桩测不出那条重试路径。
   */
  const promptService = () => {
    if (promptFailuresLeft > 0) {
      promptFailuresLeft -= 1;
      return undefined;
    }
    const remember = (entry) => {
      prompts.push(entry);
      return () => {
        const at = prompts.indexOf(entry);
        if (at >= 0) prompts.splice(at, 1);
      };
    };
    return {
      section: (s) => remember({ kind: 'section', ...s }),
      variable: (name, provider) => remember({ kind: 'variable', name, provider }),
    };
  };
  const cleanups = [];
  /**
   * 用例中途才 provide 出来的服务（`host.list.provide`）。
   *
   * 真宿主就是这样给 `connection` 的：`dsh-client-connection` 在 web 表面起来之后才
   * provide，而插件的 `apply()` 早就跑完了。插件只能靠 `ctx.inject` 等 —— 那段时序
   * 必须能在测试里复现，否则「路由永远挂不上」这类事故会一路绿到线上。
   */
  const provided = new Map();
  /** 依赖还没齐的 `ctx.inject` 回调：服务一到就（按登记顺序）跑。 */
  const deferredInjects = [];
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
  /**
   * 用例注入的 `followup` 钩子：模拟「模型在 turn 里调了工具」。
   *
   * 摘要 Agent 的 turn 在真宿主里是模型跑一轮；假 Host 里它什么都不做，所以像
   * 「私聊摘要写不写全局文件」这类用例需要在这里替模型动手。`whenIdle()` 会等钩子
   * 跑完，摘要的 settle 顺序才与真实一致。
   */
  let followupHook;
  let followupWork = Promise.resolve();
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
  /** `agentPresets` 还剩几次「服务不可见」；见 makeHost 的 presetSetupFailures。 */
  let presetFailuresLeft = presetSetupFailures;
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
      info: (...args) => infos.push(args.join(' ')),
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
      ...(loggerExporter ? { exporter: () => () => {} } : {}),
    },
    ...(fiber === undefined ? {} : { fiber }),
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
          get: (service) => (service === 'systemPrompt' ? promptService() : undefined),
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
          // 真宿主的 Agent 自带作用域上下文；热路径补挂提示小节时插件要用它。
          ctx: agentCtx,
          inbox: [],
          followup(message) {
            this.inbox.push(message);
            if (typeof followupHook === 'function') {
              const agent = this;
              followupWork = followupWork
                .then(() => followupHook(agent, message))
                .catch(() => {});
            }
          },
          /** 摘要链路会 `await agent.whenIdle()`；桩里这一轮「已经结束了」。 */
          whenIdle() {
            // `host.list.stallIdle = true` 模拟一个卡死的模型请求：永不 resolve，
            // 用来验证摘要的硬超时会把这个 Agent 收掉（而不是让摘要永远排队）。
            if (stalledIdle) return new Promise(() => {});
            return followupWork;
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
    // ctx.inject（可选依赖）：真 cordis 在依赖服务出现之后才跑回调，依赖不齐就一直等
    // —— headless 组合里 `connection` 永远不会出现，回调因此压根不跑（也不报错）。
    // 桩必须复现「迟到也跑」：设置页那条路由就是靠它挂上的（真实事故见 index.js）。
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
      if (names.every((name) => ctx.get(name) !== undefined)) {
        callback(ctx);
        return () => {};
      }
      const entry = { names, callback };
      deferredInjects.push(entry);
      return () => {
        const index = deferredInjects.indexOf(entry);
        if (index >= 0) deferredInjects.splice(index, 1);
      };
    },
    get(service) {
      // 用例中途 provide 出来的服务优先（模拟真宿主里「服务晚到」的时序）。
      if (provided.has(service)) return provided.get(service);
      // 模拟部署默认模型选择，验证「配置为空时继承默认值」。
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }) };
      }
      if (service === 'approval') return { setPolicy() {} };
      // 凭据服务：只有显式传了 credentials 的用例才有（与真实部署里一定有形成对照，
      // 也让「服务看不见时只记一条 warn、不炸」这条退路能被验到）。
      if (service === 'credentials') return credentials;
      // Web 半侧：只有显式传了 connection 的用例才有（设置页的只读任务路由挂在这里）。
      if (service === 'connection') return connection;
      // 定时器服务：插件用它排摘要循环（见上面 timeout / interval）。
      if (service === 'timer') return fakeTimer;
      // Agent 预设平面：只有传了 presets 的用例才有（与 headless 组合形成对照）。
      if (service === 'agentPresets') {
        if (presetFailuresLeft > 0) {
          presetFailuresLeft -= 1;
          return undefined;
        }
        return presetService;
      }
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
      get onFollowup() {
        return followupHook;
      },
      set onFollowup(value) {
        followupHook = value;
        followupWork = Promise.resolve();
      },
      created,
      prompts,
      warnings,
      infos,
      restrictions,
      disposed,
      mountedPresets,
      metas,
      /** 把一条事件跑过所有已注册的监听器（模拟 Harness 事件总线）。 */
      emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) handler(...args);
      },
      /**
       * 模拟「服务晚到」：provide 之后把等它的 `ctx.inject` 回调跑起来。
       * 只在该服务出现后重试一次，依赖仍然不齐的继续等（与 cordis 一致）。
       */
      provide(service, value) {
        provided.set(service, value);
        for (const entry of [...deferredInjects]) {
          if (!entry.names.includes(service)) continue;
          if (!entry.names.every((name) => ctx.get(name) !== undefined)) continue;
          deferredInjects.splice(deferredInjects.indexOf(entry), 1);
          entry.callback(ctx);
        }
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

/**
 * 取某条 user message 里的「本轮情境」块。
 *
 * 从 2026-10-19 起，每轮会变的东西（当前发言者、群环境、检索到的记忆、当前时间、
 * 待发提醒、人设的场景段）不再挂在系统提示小节里 —— 动态小节会让 DSH 每轮追加一整份
 * 系统提示（见 index.js `channelTurnContext` 的注释）。它们现在是 user message 的第二个
 * text block，第一个 block 仍然是真正的消息正文。
 */
function turnContextText(agent) {
  const message = agent?.inbox?.[agent.inbox.length - 1];
  const blocks = message?.content ?? [];
  return blocks.slice(1).map((block) => block.text ?? '').join('\n');
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

/**
 * 等到「Agent 造出来了」**并且它的收件箱里已经有至少 `count` 条消息**。
 *
 * 为什么不只看 `host.list.created[0]`：假 Host 的 `create()` 是**如实照搬真宿主**的 ——
 * Agent 对象先造出来并记进 `created`，消息由插件在**之后**才 `agent.followup(...)` 投进去
 * （中间还隔着登记发言人、解环境上下文、挂提示词小节这些 await）。20ms 的轮询因此会偶尔
 * 抢在投递之前断言，表现是「`inbox[0]` 是 undefined」或者 `completeTurn` 拿着
 * `message: undefined` 去开 turn —— 本机在跑全量（机器较忙）时抓到过两次真实翻车。
 *
 * 所以「要读 inbox 的用例」统一用这个等待；只关心 Agent 被创建（例如断言创建了**几个**、
 * 或只是想 emit 事件）的用例仍然直接用 `until(() => host.list.created[0], …)`。
 */
async function untilInbox(host, count = 1, message = 'the message to reach the Agent') {
  return until(() => (host.list.created[0]?.inbox.length >= count ? host.list.created[0] : undefined), message);
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

/**
 * 造一条群聊入站事件；`messageId` 用于验证引用回复。
 *
 * `name`（昵称）与 `card`（群名片）**刻意给成两个不同的值**，别顺手统一：
 * 「显示名优先群名片、其次昵称」这条优先级靠它才测得出来（index.js 的
 * `userDisplayName`）—— 两者一样的话断言依然会绿，但没在验东西。这个名字同时也是
 * `[[@昵称]]` 要照抄的那个名字（见 mention.js）。
 */
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
 * 所有起过的插件实例：用例结束时统一收尾。
 *
 * 插件会持有 OneBot socket（以及主动说话、补一句那些短定时器），
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
  // 工作目录也给它一个临时目录，**不要**写死 `/tmp`：Windows 上那会被 resolve 成
  // `<当前盘符>:\tmp`，于是跑一次测试就在用户的 D 盘（或 C 盘）根目录下留一份
  // `.qq-media` / `.qq-memory` / `.qq-stickers`。用例要断言 cwd 时用返回的 `instance.cwd`。
  const cwd = config.cwd ?? await mkdtemp(join(tmpdir(), 'qq-bridge-cwd-'));
  const host = makeHost({ sessionsRoot, ...hostOptions });
  // 用 Config() 过一遍真实 schema，测试里传的配置因此也顺带验证了默认值合并。
  // 延迟一律压到 0：拟人节奏不该让测试多等几秒，需要验证时序的用例自己覆盖。
  // 攒批窗口同理：默认关掉，要验证「几个人同时 @ 只回一轮」的用例自己给一个小窗口。
  apply(host.ctx, Config({
    endpoint: onebot.endpoint,
    cwd,
    readDelayMs: 0,
    minDelayMs: 0,
    maxDelayMs: 0,
    batchWindowMs: 0,
    ...config,
  }));
  // 先登记再启动：`start()` 跑的是 `ctx.effect` 的回调（OneBot 连接、摘要与主动说话的
  // 定时器），它可能抛错 —— 例如插件漏声明 inject 时的 cordis 检查。抛错时这个实例也
  // 必须进收尾清单，否则刚起的假 OneBot 服务端会一直挂着监听，让整个测试文件停不下来
  // （node 的 test runner 会等到事件循环空掉）。这类失败要「红得快且干净」。
  const instance = { onebot, host, sessionsRoot, cwd };
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

    // 等到消息真的投进 Agent 的收件箱（理由见 untilInbox）。
    const agent = await untilInbox(host, 1, 'the private message to reach the Agent');
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

// 用例：setup 时 `systemPrompt` 服务还没 active（strict get 返回 undefined），渠道提示
// 小节没挂上 —— 下一条消息复用 Agent 时必须补挂回来。
//
// 真实事故：19:48 那次 resume 正好赶在服务可见之前，旧代码拿不到服务就静默 return，
// 于是这个 Agent 带着**裸系统提示词**一直跑到下次重启：人设与表达规则全丢，群里的回复
// 又退化成「才没有 是你没跟上我」这种空格断句（而 STYLE.md 明明写着不许）。重启能修好，
// 但没人知道要重启 —— 所以这里钉的是「不重启也能自愈」。
test('the channel prompt is retried on the next message when systemPrompt is not ready yet', async () => {
  // 把 setup 里的三次尝试（0ms / 50ms / 200ms）全部打空，模拟服务一直不可见。
  const { onebot, host } = await boot({}, { promptSetupFailures: 3 });
  try {
    onebot.push(privateMessage('你好'));
    await untilInbox(host, 1, 'the first message to reach the Agent');
    // 第一轮服务不可见：没有渠道小节，但必须留下一条 warn（否则这次丢失永远没人发现）。
    const hasSection = () => host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel');
    assert.equal(hasSection(), false, '第一轮拿不到服务时确实挂不上');
    assert.ok(
      host.list.warnings.some((line) => line.includes('systemPrompt') && line.includes('channel prompt')),
      '服务不可见要留 warn，不能静默跳过',
    );

    // 第二条消息复用同一个 Agent（走 ensureAgent 的热路径），这一次服务已经可见：
    // 渠道小节（连同 {{model}} / {{provider}} 变量）必须补挂回来。
    onebot.push(privateMessage('还在吗'));
    await until(hasSection, 'the channel prompt to be re-attached on the next message');
    assert.equal(promptText(host, 'qq-bridge:channel').includes('不许拿空格当标点'), true, '补挂的是完整那一节');
    assert.equal(host.list.prompts.find((entry) => entry.kind === 'variable' && entry.name === 'model').provider(), 'deepseek-flash');
  } finally {
    await onebot.close();
  }
});

// 用例：竞态只晚一拍时（第一次 get 失败、50ms 后服务出现），setup 里的重试要当场把它接住 ——
// 第一条回复就不该落在「没有渠道提示词」的状态。
test('the channel prompt waits out a one-tick systemPrompt race inside setup', async () => {
  const { onebot, host } = await boot({}, { promptSetupFailures: 1 });
  try {
    onebot.push(privateMessage('你好'));
    await untilInbox(host, 1, 'the first message to reach the Agent');
    assert.equal(
      host.list.prompts.some((entry) => entry.kind === 'section' && entry.name === 'qq-bridge:channel'),
      true,
      '第一次 get 失败后要重试到服务出现',
    );
    assert.equal(
      host.list.warnings.some((line) => line.includes('systemPrompt') && line.includes('channel prompt')),
      false,
      '重试成功时不该报「整轮缺提示词」的 warn',
    );
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
    // 与上面那条私聊用例同一个道理：群里这条路上还要登记发言人、解环境上下文，
    // 所以等到消息真的进了收件箱再断言（理由见 untilInbox）。
    const agent = await untilInbox(host, 1, 'the group message to reach the Agent');
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

// ---- 空消息（单纯的 @ / 一个空格）-----------------------------------------------------
//
// 这一组的前提是「没有正文不等于没有说话」：`@bot` 一下、或者私聊发一个空格，都是明确
// 点了它却又什么都没写。旧行为是 `admit` 直接丢掉，现在照常投给模型、只在正文位置放一句
// 说明，由它看着上下文决定回「？」、发张表情还是接上一句（`blankReply: false` 可关回旧行为）。

/** 空消息的替身文案是模块级纯函数，先钉住三种情形的措辞。 */
test('blankMessageLabel：群里被 @ / 群里没被 @ / 私聊，三种情形分开说', () => {
  assert.equal(blankMessageLabel({ group: true, mentionedMe: true }), '（@了你一下，没有说别的）');
  assert.equal(blankMessageLabel({ group: true, mentionedMe: false }), '（一条空消息，没有正文）');
  assert.equal(blankMessageLabel({ group: false }), '（对方发来一条空消息，什么都没写）');
  // 缺省/非法入参按「私聊的普通空消息」处理，不能抛错也不能给出空串（那等于没兜住）。
  assert.equal(blankMessageLabel(), '（对方发来一条空消息，什么都没写）');
  assert.equal(blankMessageLabel({ group: true }), '（一条空消息，没有正文）');
});

/** 群里单纯 @ 一下：照常开一轮，模型看到的是「@ 了你一下，没有说别的」。 */
test('a bare @ still reaches the Agent with a note instead of being dropped', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention(''));
    const agent = await untilInbox(host, 1, 'the bare mention to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（@了你一下，没有说别的）');

    // 一轮正常的回复照常发得出去（模型回个「？」是最自然的反应）。
    completeTurn(host, agent, '？', 1);
    assert.equal(await until(() => sentTexts(onebot)[0], 'the reply to a bare mention'), '？');
  } finally {
    await onebot.close();
  }
});

/** 只有空白字符（或者只有 @ + 空格）同样算空消息：`trim` 之后什么都不剩。 */
test('whitespace-only group messages count as blank, and groupTrigger: all says so plainly', async () => {
  const { onebot, host } = await boot({ groupTrigger: 'all' });
  try {
    // `all` 模式没有 @ 这回事，替身不该说「@ 了你一下」。
    onebot.push(groupText('   '));
    const agent = await untilInbox(host, 1, 'the blank message to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（一条空消息，没有正文）');
  } finally {
    await onebot.close();
  }
});

/** 私聊发一个空格：以前静默丢弃，现在交给模型（私聊的措辞与群聊不同）。 */
test('a whitespace-only private message is answered instead of ignored', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('  '));
    const agent = await untilInbox(host, 1, 'the blank private message to create the Agent');
    assert.equal(agent.inbox[0].content[0].text, '（对方发来一条空消息，什么都没写）');

    completeTurn(host, agent, '？', 1);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    assert.equal(sent, '？');
  } finally {
    await onebot.close();
  }
});

/** `blankReply: false` 回到旧行为：空消息一律静默丢弃，连会话都不建。 */
test('blankReply: false restores dropping messages that have no text', async () => {
  const { onebot, host } = await boot({ blankReply: false });
  try {
    onebot.push(mention(''));
    onebot.push(privateMessage('   '));
    await settle(150);
    assert.equal(host.list.created.length, 0, '空消息不该建会话');
    assert.deepEqual(sentTexts(onebot), []);
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), []);
  } finally {
    await onebot.close();
  }
});

/** 空消息不能被当成指令：单纯的 `@bot` 永远只走模型，不触发任何旁路。 */
test('a bare @ reaches the model instead of a command bypass', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention(''));
    const agent = await untilInbox(host, 1, 'the bare mention to create the Agent');
    await settle(60);
    assert.equal(agent.inbox[0].content[0].text, '（@了你一下，没有说别的）');
    // 旁路会直接回一句「用法：…」；这里既没有那条回复，也没有任何 send_*。
    assert.deepEqual(sentTexts(onebot), []);
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
    // 名字**不带 QQ 号**：号码印在提示词里，模型就会照着念出来（那正是不该发生的事），
    // 而它想 @ 谁时写的是 `[[@昵称]]`（见 mention.js / 下面那组用例）。
    const context = turnContextText(agent);
    assert.ok(context.includes('几乎同时在跟你说话的是：kaguya、iroha、mutsumi'), context);
    assert.ok(!context.includes('100000003'), context);
    assert.ok(!context.includes('4444444444'), context);

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

// 长任务期间来的 @ 不排成 N 轮、N 条回复：先攒着，忙完当作「一波迟到的消息」只接一轮。
test('mentions that arrive during a long turn become one backlog wave', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 80, batchMaxWaitMs: 150, batchBacklogHoldMs: 30000, replyStyle: 'auto' });
  try {
    onebot.push(mention('第一句', { messageId: 7501 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    // 第一句开了一轮，但**不结束**：模拟一个还在跑的长任务（turn/end 一直不来）。
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7502, userId: 3333333333, name: 'iroha', card: 'iroha' }));
    onebot.push(mention('第三句', { messageId: 7503 }));
    onebot.push(mention('第四句', { messageId: 7504 }));

    // 早就超过攒批窗口与上限了，但它在忙 —— 一条都不该进收件箱。
    await settle(400);
    assert.equal(agent.inbox.length, 1, 'while the turn is running, the backlog must stay out of the inbox');

    // 长任务结束：这一波作为**一条**消息投进来。
    host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await until(() => (agent.inbox.length === 2 ? agent.inbox[1] : undefined), 'the backlog wave to reach the Agent');
    const wave = agent.inbox[1].content[0].text;
    assert.match(wave, /^（你刚才在忙别的事，/, wave);
    assert.match(wave, /iroha（(刚刚|\d+ 秒前)）: 第二句/, wave);
    assert.ok(wave.includes('第三句') && wave.includes('第四句'), wave);
    assert.ok(wave.includes('就只写 SKIP'), wave);
    // 场景提示词也得说清「你刚才在忙」，不能再写「几乎同时在跟你说话」。
    const context = turnContextText(agent);
    assert.ok(context.includes('你刚才在忙别的事'), context);
    assert.ok(!context.includes('几乎同时在跟你说话'), context);

    // 接完这一波：只发裸文本（不引用几分钟前的那一条），整波共用一轮。
    completeTurn(host, agent, '刚在忙，我看看', 2);
    const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the backlog reply');
    assert.equal(sent.params.message, '刚在忙，我看看');
    await settle(200);
    assert.equal(agent.inbox.length, 2, 'the whole backlog must be answered in one turn');
  } finally {
    await onebot.close();
  }
});

// 憋的上限：长任务一直不结束也不能让这些消息永远投不出去（退回「排队等它忙完」）。
test('the backlog hold gives up after batchBacklogHoldMs', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 80, batchMaxWaitMs: 150, batchBacklogHoldMs: 50 });
  try {
    onebot.push(mention('第一句', { messageId: 7601 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7602 }));
    // 过了 50ms 的上限就直接投进队列（仍然是积压文案，但不再等它空闲）。
    const queued = await until(
      () => (agent.inbox.length >= 2 ? agent.inbox[1].content[0].text : undefined),
      'the overdue backlog to be queued anyway',
      3000,
    );
    assert.ok(queued.includes('第二句'), queued);
    assert.match(queued, /^（你刚才在忙别的事，/, queued);
  } finally {
    await onebot.close();
  }
});

// 关掉这一项 = 回到「每 batchMaxWaitMs 一批排队」的老行为。
test('batchBacklog: false keeps queueing one batch at a time', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 60, batchMaxWaitMs: 120, batchBacklog: false });
  try {
    onebot.push(mention('第一句', { messageId: 7701 }));
    const agent = await untilInbox(host, 1, 'the first message to reach the Agent');
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });

    onebot.push(mention('第二句', { messageId: 7702 }));
    const queued = await until(
      () => (agent.inbox.length >= 2 ? agent.inbox[1].content[0].text : undefined),
      'the second batch to be queued as before',
      3000,
    );
    // 老行为：普通批次（单个条目不包装），不是「刚才在忙」那一波。
    assert.equal(queued, '第二句');
  } finally {
    await onebot.close();
  }
});

// 用例：/reset 之前攒着的那批话要先投出去 —— 它们是重置前说的，不能被新一轮忘掉。
test('the reset command delivers a pending batch before it starts the next round', async () => {
  const { onebot, host } = await boot({ batchWindowMs: 200, batchMaxWaitMs: 400, resetUsers: [String(PRIVATE_USER_ID)] });
  try {
    onebot.push(privateMessage('你好'));
    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');
    // 攒着的那条消息在开始新一轮之前投了出去，Agent 随后才被销毁。
    const first = host.list.created[0];
    assert.ok(first, 'the pending batch should reach the Agent before the reset');
    assert.equal(first.inbox[0].content[0].text, '你好');
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
  } finally {
    await onebot.close();
  }
});

// 用例：攒批窗口的默认值是可以直接用的「人味」节奏，也可以关掉。
// （配置 schema 是根 volatile，`Config()` 解析出来的是引用，读值要先摊平 —— 见 util.js 的 liveConfig。）
test('the batch window defaults to a human beat and can be turned off', () => {
  assert.equal(liveConfig(Config({})).batchWindowMs, 2000);
  assert.equal(liveConfig(Config({})).batchMaxWaitMs, 5000);
  assert.equal(liveConfig(Config({ batchWindowMs: 0 })).batchWindowMs, 0);
});

// 用例：配置在 Web UI 里保存之后走的是 Loader 的「volatile 热更新」路径 —— 它就地换掉
// 引用里的值、**不重跑 apply()**。插件的连接、定时器、工具注册、目录校验全在 apply 里
// 装配，所以它必须自己重启一次（`ctx.fiber.restart()`），否则界面上改了配置毫无反应。
test('配置热更新（volatile-update）之后插件重启自己，同一拍里只重启一次', async () => {
  const fiber = {
    restarts: 0,
    restart() {
      this.restarts += 1;
      return Promise.resolve();
    },
  };
  const { host } = await boot({}, { fiber });

  assert.equal(fiber.restarts, 0, '启动时不该重启');

  // 一次保存可能报出多个字段：事件是每条路径一次，但只该重启一次。
  host.list.emit('loader/volatile-update', [['repeatChance']]);
  host.list.emit('loader/volatile-update', [['proactiveChance']]);
  await until(() => fiber.restarts === 1, '热更新之后插件重启自己');
  await settle(60);
  assert.equal(fiber.restarts, 1, '一拍里只重启一次（重启本身会重跑 apply、重建监听）');
  assert.ok(
    host.list.infos.some((line) => line.includes('配置已更新')),
    '重启必须留下一条日志，否则线上排查「改了没生效」时无从下手',
  );
});

test('没有 fiber 的组合里配置热更新只记一条 warn，不假装配置生效了', async () => {
  const { host } = await boot();

  host.list.emit('loader/volatile-update', [[]]);
  await settle(20);
  assert.ok(
    host.list.warnings.some((line) => line.includes('fiber.restart')),
    '拿不到 fiber 时要说明「这份配置要重启进程才生效」',
  );
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

// 用例八：allowTools 把 QQ 会话 Agent 收窄到白名单内；留空（显式 []）则完全不限制。
test('allowTools restricts the QQ agent to the configured tools', async () => {
  // 默认值就是那 14 个（只读文件 + 检索 + 联网 + 七个 qq_*），每个 Agent 都要被收窄。
  const byDefault = await boot({}, { knownTools: DEFAULT_ALLOW_TOOLS });
  try {
    byDefault.onebot.push(privateMessage('你好'));
    const agent = await until(() => byDefault.host.list.created[0], 'the default-restricted Agent');
    assert.deepEqual(byDefault.host.list.restrictions, [
      { sessionId: agent.id, filter: { allow: DEFAULT_ALLOW_TOOLS } },
    ]);
    // 默认收窄里没有 shell：QQ 消息是不可信输入。
    assert.ok(!DEFAULT_ALLOW_TOOLS.includes('bash'));
    assert.ok(!DEFAULT_ALLOW_TOOLS.includes('write'));
  } finally {
    await byDefault.onebot.close();
  }

  // 显式留空 = 不施加任何限制（与未引入该配置时的行为一致）。
  const plain = await boot({ allowTools: [] });
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

  // 默认 `agentPreset: 'qq'` 指向本 bundle 的预设；这条用例验的是「留空 = 部署的默认预设」
  // 那条路，所以显式写空串。
  const { onebot, host, cwd } = await boot({ agentPreset: '', allowTools }, { presets });
  try {
    onebot.push(privateMessage('帮我查一下今天的新闻'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    // 加入的是部署的默认预设，并且写进了会话 header 的 agentPreset。
    assert.deepEqual(host.list.mountedPresets, ['standard']);
    assert.deepEqual(host.list.metas, [{ sessionId: agent.id, meta: { cwd, agentPreset: 'standard' } }]);
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

// 用例：启动竞态里预设平面还不可见时，setup 只记一次 warn；**下一条消息**必须补挂
// 成功。漏挂的后果不只是工具面 —— 预设里的 compaction 也一起漏了，上下文会一路涨到
// 部署默认门槛（0.8×1M）才压缩，看起来就是「聊得越久越笨」（真实事故，2026-10-19）。
test('an unavailable agentPresets service is retried on the next message', async () => {
  const presets = {
    default: 'standard',
    compositions: {
      standard: ['bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'],
    },
  };
  // 前两次 get 都返回 undefined：一次给 create 前的 resolve，一次给 setup 里的补挂。
  const { onebot, host } = await boot({ agentPreset: '', allowTools: ['read'] }, { presets, presetSetupFailures: 2 });
  try {
    onebot.push(privateMessage('第一句'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    // setup 里没挂上：只记一条 warn，回复链路照常。
    assert.deepEqual(host.list.mountedPresets, []);
    assert.ok(host.list.warnings.some((line) => line.includes('agent preset') || line.includes('agentPresets')), host.list.warnings.join('|'));
    assert.equal(agent.inbox.length, 1);

    onebot.push(privateMessage('第二句'));
    await untilInbox(host, 2, 'the retry to happen on the next message');
    // 服务出现之后热路径补挂成功，预设里的工具才真正可达。
    await until(() => host.list.mountedPresets.includes('standard'), 'the preset to be mounted on retry');
    assert.deepEqual(host.list.mountedPresets, ['standard']);
    assert.deepEqual(host.list.restrictions.at(-1), { sessionId: agent.id, filter: { allow: ['read'] } });
  } finally {
    await onebot.close();
  }
});

// 用例：系统提示小节**不含**每轮会变的东西；当前发言者 / 群环境 / 当前时间都在
// user message 的第二个 text block 里。这是 2026-10-19「越聊越笨」的回归：
// 动态小节会让 DSH 每轮追加一整份系统提示（约 9k token），十几轮就 220k 上下文。
test('the channel system section stays stable while per-turn data rides on the user message', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(mention('在吗', { messageId: 11 }));
    const agent = await untilInbox(host, 1, 'the first turn');
    const firstSection = promptText(host, 'qq-bridge:channel');
    const firstContext = turnContextText(agent);
    assert.ok(firstContext.includes('刚跟你说话的人：kaguya'), firstContext);
    // 动态数据不能再出现在系统小节里：出现一次，DSH 就会追加一次整段提示。
    assert.ok(!firstSection.includes('刚跟你说话的人：'), firstSection);
    assert.ok(!firstSection.includes('现在是 '), firstSection);

    onebot.push(mention('还在吗', { messageId: 12, userId: 333, name: 'iroha', card: 'iroha' }));
    await untilInbox(host, 2, 'the second turn');
    const secondSection = promptText(host, 'qq-bridge:channel');
    const secondContext = turnContextText(agent);
    assert.equal(secondSection, firstSection, '系统小节必须逐字稳定，否则 DSH 每轮都会追加一份');
    assert.ok(secondContext.includes('刚跟你说话的人：iroha'), secondContext);
    assert.notEqual(secondContext, firstContext);
  } finally {
    await onebot.close();
  }
});

// 用例：宿主那几段「编码代理 / Web GUI / 文件卡片」的小节，在 QQ 会话的作用域里
// 必须被**同名**覆盖掉（`HOST_PROMPT_SHADOWS`）—— 它们压在系统提示的首尾，比渠道小节
// 更像「我是谁」。断言的是注册的小节名字与文本，而不是拼装后的整段提示（拼装是宿主的事）。
test('the channel prompt shadows the host sections that frame a coding agent', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    await untilInbox(host, 1, 'the first turn');
    const byName = new Map(host.list.prompts.filter((entry) => entry.kind === 'section').map((entry) => [entry.name, entry]));
    for (const name of [
      'harness:identity',
      'deployment:persona-prefix',
      'ui:deliverable-file-references',
      'harness:source',
      'app:web-surface',
      'deployment:persona-suffix',
    ]) {
      assert.ok(byName.has(name), `the scenario section "${name}" must be shadowed in the agent scope`);
    }
    // 空文本 = 装配时整段丢掉；persona 前缀换成 QQ 会话自己的身份，不再自称编码代理。
    assert.equal(byName.get('app:web-surface').text, '');
    assert.equal(byName.get('deployment:persona-prefix').text, '你是一个在 QQ 群里跟人聊天的人，不是助手，也不是编程代理。');
    assert.ok(!byName.get('deployment:persona-prefix').text.includes('coding agent'));
    // 渠道小节本身还在（别把覆盖写成了替换）。
    assert.ok(byName.has('qq-bridge:channel'));
  } finally {
    await onebot.close();
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
    assert.deepEqual(skipped.host.list.metas[0].meta, { cwd: skipped.cwd });
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
  //   - qq_send_* / qq_poke / qq_list_conversations：一直注册；
  //   - qq_save_sticker：表情包目录可用时才注册（白名单里有它、但目录配到 cwd 外时，
  //     插件只是不注册那个工具 —— 这与「白名单挡掉」是两条独立的路，见 tools.js）；
  //   - qq_transcript / qq_memory：memory 开着时才注册；
  //   - qq_remind_*：定时提醒开着且任务文件在 cwd 内时才注册；
  //   - skill：由预设里的 tool-skill 提供。
  const provided = new Set([
    'qq_send_message',
    'qq_send_image',
    'qq_save_sticker',
    'qq_rename_sticker',
    'qq_list_conversations',
    'qq_poke',
    'qq_remind_create',
    'qq_remind_list',
    'qq_remind_cancel',
    'skill',
  ]);
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

// 用例：一键脚本写进 `.env` 的取值，插件必须真的读得到。
//
// 这条链路是「发布版方便」的全部：`scripts/napcat-setup.cmd` 把 endpoint / cwd / NapCat
// 目录写进 profile 目录的 `.env`，而 DSH 只把 `.env` 变成环境变量 —— **把它们接进配置的
// 是 patch 里的 `!!js process.env.QQBOT_*`**。哪天有人图省事把某一项写死回常量，一键脚本
// 就会静默失效（用户看到的是「明明跑了脚本还是连不上」），所以在这里钉住这几行。
test('the bundled patch reads the QQBOT_* variables the Windows setup script writes', async () => {
  const jsExpression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => data });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsExpression]);
  const doc = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema });
  const bridge = doc.flatMap((entry) => entry.insert ?? []).find((row) => row.name === '@qqbot/dsh-plugin-qq');
  const expected = {
    endpoint: 'QQBOT_ENDPOINT',
    accessToken: 'QQBOT_ACCESS_TOKEN',
    cwd: 'QQBOT_CWD',
    napcatDir: 'QQBOT_NAPCAT_DIR',
    napcatAutoConfig: 'QQBOT_NAPCAT_AUTOCONFIG',
  };
  for (const [field, variable] of Object.entries(expected)) {
    const value = bridge.config[field];
    assert.equal(typeof value, 'string', `${field} 应当是 !!js 表达式`);
    assert.ok(value.includes(variable), `${field} 必须读 ${variable}（否则一键脚本写的 .env 不起作用），现在是：${value}`);
  }
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
    // 会话 id 由 PRIVATE_USER_ID 经 SHA-256 派生，所以这里**现算**前缀 ——
    // 写死一个常量的话，改测试用的 QQ 号就会莫名其妙地弄红这个用例。
    const prefix = sessionIdFor(`private:${PRIVATE_USER_ID}`, 0).slice(0, 8);
    return lines.filter((line) => line.startsWith('qq-bridge: ') && line.includes(`created ${prefix}`));
  };

  // 真实宿主的 logger 门面带 exporter() -> 镜像。
  assert.equal((await capture({ loggerExporter: true })).length, 1);
  // 测试用的普通日志桩没有 -> 不镜像（同时让测试输出保持干净）。
  assert.deepEqual(await capture({}), []);
});

// 用例十：/reset 新开一轮会话 —— 销毁活着的 Agent、换一个 Session id 重新开始，
// 而**旧会话的记录留在磁盘上**（不删）。指令本身不会被投递给 Agent。
test('the reset command opens a new session instead of deleting the old one', async () => {
  const { onebot, host, sessionsRoot } = await boot({ resetUsers: [String(PRIVATE_USER_ID)] });
  try {
    onebot.push(privateMessage('你好'));
    const first = await untilInbox(host, 1, 'the Agent to be created');
    // 假后端在 create 时已落地磁盘记录，先确认它存在。
    const storedDir = join(sessionsRoot, '--fake-project--', first.id);
    assert.ok(existsSync(storedDir));

    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    assert.equal(confirmation.params.user_id, '100000002');

    // 旧 Agent 被销毁，但旧会话的磁盘记录**保留**下来当存档。
    await until(() => host.list.disposed.includes(first.id), 'the Agent to be disposed');
    assert.ok(existsSync(storedDir), 'the old session must be kept on disk, not deleted');
    // 指令没有进 Agent 的收件箱（只有最开始那条「你好」）。
    assert.equal(first.inbox.length, 1);

    // 再来一条消息：必须是新的 Agent（新对象）**并且换了 Session id**，
    // 证明新一轮既没有复用旧 Agent，也没有 resume 旧会话。
    onebot.push(privateMessage('还记得我刚才说什么吗'));
    const second = await until(() => host.list.created[1], 'a fresh Agent after the reset');
    assert.notEqual(second, first);
    assert.notEqual(second.id, first.id, 'the new round must use a different session id');
    assert.equal(second.inbox.length, 1);
    assert.equal(second.inbox[0].content[0].text, '还记得我刚才说什么吗');
    // 会话列表里报的也是新一轮的 id。
    const listed = await host.tools.get('qq_list_conversations').execute({}, {});
    assert.equal(listed.sessions[0].session_id, second.id);
    assert.equal(listed.sessions[0].session_round, 1);
  } finally {
    await onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

// 用例：/reset 开到了第几轮是**落盘**的 —— 插件重启后不该把 reset 之前那段会话
// resume 回来（那等于 /reset 白按了）。两个实例共用一个会话根目录模拟同一个部署重启。
test('the session round survives a plugin restart', async () => {
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'qq-bridge-restart-'));
  // 其余节奏参数压到 0：这个用例关心的是「跨进程还在不在第 1 轮」，不是时序。
  // endpoint 必须留给 boot 自己填（假 OneBot 服务端的地址）；cwd 也交给 boot
  // （它会给一个临时目录 —— 写死 `/tmp` 在 Windows 上会落到 `D:\tmp` 去）。
  const config = { readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, batchWindowMs: 0, resetUsers: [String(PRIVATE_USER_ID)] };
  let first;
  let second;
  let before;
  try {
    // 第一段：说一句 → /reset（第 1 轮）。
    first = await boot({ ...config }, { sessionsRoot });
    first.onebot.push(privateMessage('你好'));
    before = await until(() => first.host.list.created[0], 'the first Agent');
    assert.equal(before.id, sessionIdFor('private:100000002', 0));
    first.onebot.push(privateMessage('/reset'));
    await until(
      () => first.onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation to reach QQ',
    );
    // 标记是在确认发出**之前**就写完的（`resetConversation` 会 await 它）：所以这里
    // 直接就能看到它，这正是「说完就重启也不会退回第 0 轮」的保证。
    const marker = join(sessionsRoot, 'reset', 'private-100000002.json');
    await until(() => existsSync(marker), 'the session round marker on disk');
  } finally {
    await first?.onebot.close();
  }
  try {
    // 第二段：同一个会话根目录重新起一个插件（进程重启），再来一条消息。
    second = await boot({ ...config }, { sessionsRoot });
    second.onebot.push(privateMessage('重启之后呢'));
    const after = await until(() => second.host.list.created[0], 'the Agent after the restart');
    // 重启后仍然在第 1 轮：既不是第 0 轮那个 id（那会把 reset 前的会话 resume 回来），
    // 也不是新一轮新算出来的另一个 id —— 第 1 轮的 id 是确定性的、跨进程一致的。
    assert.notEqual(after.id, sessionIdFor('private:100000002', 0));
    assert.equal(after.id, sessionIdFor('private:100000002', 1));
    assert.notEqual(after.id, before.id);
  } finally {
    await second?.onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

// 用例：只有 resetUsers 里的人能重置。
//
// 默认是**空白名单 = 谁都不能**（与 allowUsers 的「空 = 不限制」相反）：群消息是不可信
// 输入，一个「没配就等于人人可用」的重置指令，等于让群里任何一个人都能悄悄把会话记忆
// 重开一轮。没权限的人**静默忽略**：不重置、也不告诉它「你没有权限」。
test('the reset command only works for accounts listed in resetUsers', async () => {
  const { onebot, host, sessionsRoot } = await boot({
    resetUsers: [String(PRIVATE_USER_ID)],
    batchWindowMs: 200,
    batchMaxWaitMs: 400,
  });
  try {
    // ① 没权限的人发 /reset：连攒批都不该被它提前投出去（权限判断在 flushBatch 之前），
    //    也不该有任何回复。
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 999,
      sender: { nickname: 'soyo' },
      message: [{ type: 'text', data: { text: '/reset' } }],
    });
    await settle(600); // 超过 batchMaxWaitMs，够攒批自然投出去了
    assert.equal(host.list.created.length, 0, 'a stranger must not be able to open a session at all');
    assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false, 'and must get no reply');

    // ② 权限里的人发 /reset：照常开新一轮。
    onebot.push(privateMessage('/reset'));
    const confirmation = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && call.params.message.includes('已开始新会话')),
      'the reset confirmation for the allowed account',
    );
    assert.equal(confirmation.params.user_id, String(PRIVATE_USER_ID));
    // 真的换了轮次：磁盘上落下了第 1 轮的标记（0 轮那个会话还没被创建过，所以用文件名断言）。
    const marker = join(sessionsRoot, 'reset', 'private-100000002.json');
    await until(() => existsSync(marker), 'the round marker for private:100000002');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).count, 1);
  } finally {
    await onebot.close();
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});

// 用例：群里重置看的是**发言者**的 QQ 号，不是群号；而没权限的人那条连模型都进不去。
test('in a group the reset permission follows the speaker, not the group', async () => {
  const { onebot, host } = await boot({ resetUsers: [String(GROUP_USER_ID)] });
  try {
    // 群里另一个人 @它发 /reset：不是指令（没权限），也不会被当成一句话投给模型 ——
    // 它只是被静默丢掉，所以不会凭空建出一个会话。
    onebot.push(mention('/reset', { userId: 10001, card: 'soyo' }));
    await settle(200);
    assert.equal(onebot.calls.some((call) => call.action === 'send_group_msg'), false, 'no reply for the stranger');
    assert.equal(host.list.created.length, 0, 'the stranger must not open a session either');

    // 权限里的那个人 @它发 /reset：生效。
    onebot.push(mention('/reset'));
    await until(
      () => onebot.calls.some((call) => call.action === 'send_group_msg' && String(call.params.message).includes('已开始新会话')),
      'the reset confirmation from the allowed speaker',
    );
  } finally {
    await onebot.close();
  }
});

// 用例十一：resetCommand 留空即禁用；此时 /reset 只是一句普通消息。
test('an empty resetCommand disables the reset handling', async () => {
  const { onebot, host } = await boot({ resetCommand: '' });
  try {
    onebot.push(privateMessage('/reset'));
    const agent = await untilInbox(host, 1, 'the Agent to be created');
    assert.equal(agent.inbox.length, 1);
    assert.equal(agent.inbox[0].content[0].text, '/reset');
    assert.deepEqual(host.list.disposed, []);
    // 没有任何「已开始新会话」的回复发出。
    assert.equal(onebot.calls.some((call) => call.action === 'send_private_msg'), false);
  } finally {
    await onebot.close();
  }
});

// 用例：静默太久（idleResetHours）之后的第一条消息自动开新一轮 —— 不需要任何人
// 发 `/reset`。这里取一个很小的小时数（0.00002 ≈ 72ms），等够它再发第二条。
test('idleResetHours opens a new round after a long silence', async () => {
  const { onebot, host } = await boot({ idleResetHours: 0.00002 });
  try {
    onebot.push(privateMessage('第一句'));
    const first = await untilInbox(host, 1, 'the first Agent');
    completeTurn(host, first, '嗯');
    await new Promise((resolve) => setTimeout(resolve, 120));
    onebot.push(privateMessage('第二句'));
    const second = await until(() => host.list.created[1], 'a fresh Agent after the idle gap');
    assert.notEqual(second.id, first.id, '静默超过 idleResetHours 之后必须换一个 Session id');
    assert.ok(host.list.disposed.includes(first.id), '旧 Agent 必须销毁，不能让两个同时挂在同一个会话上');
    assert.equal(second.inbox[0].content[0].text, '第二句', '触发换轮的那条消息本身不能被丢掉');
  } finally {
    await onebot.close();
  }
});

// 用例：没静默够就不换轮；idleResetHours: 0（默认）等于关闭。
test('a short pause and the default setting both keep the same round', async () => {
  const { onebot, host } = await boot({ idleResetHours: 12 });
  try {
    onebot.push(privateMessage('第一句'));
    const first = await untilInbox(host, 1, 'the first Agent');
    completeTurn(host, first, '嗯');
    onebot.push(privateMessage('第二句'));
    await until(() => first.inbox.length >= 2, 'the second message to reach the same Agent');
    assert.equal(host.list.created.length, 1, '12 小时的静默门槛没到，不该换轮');
    assert.equal(first.id, host.list.created[0].id);
  } finally {
    await onebot.close();
  }

  const off = await boot();
  try {
    off.onebot.push(privateMessage('第一句'));
    const agent = await untilInbox(off.host, 1, 'the first Agent');
    completeTurn(off.host, agent, '嗯');
    await new Promise((resolve) => setTimeout(resolve, 120));
    off.onebot.push(privateMessage('第二句'));
    await until(() => agent.inbox.length >= 2, 'the second message to reach the same Agent');
    assert.equal(off.host.list.created.length, 1, 'idleResetHours 默认 0 = 关闭，永远不自动换轮');
  } finally {
    await off.onebot.close();
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
    const text = turnContextText(agent);
    // 之前的闲聊按「昵称: 内容」出现，模型因此知道大家在聊什么。
    assert.ok(text.includes('kaguya: 晚上吃啥'), text);
    assert.ok(text.includes('iroha: 随便'), text);
    // 被 @ 的那条走 user message 的第一块，不在环境块里重复一遍。
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
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const text = turnContextText(agent);
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

// 用例：一串相同消息里只跟一次 —— 跟完之后链留着（标成 `repeated`），后面再来同样的
// 消息只记账、不再跟，直到有人说了别的话把链打断，下一串才重新攒人数。
test('the bot repeats once per run, and only starts over after the chain breaks', async () => {
  const { onebot } = await boot();
  try {
    onebot.push(groupText('6', { messageId: 90 }));
    onebot.push(groupText('6', { userId: 3333333333, card: 'iroha', messageId: 91 }));
    assert.equal(await until(() => sentTexts(onebot)[0], 'the repeat'), '6');

    // 第 3、4、5 条相同的消息都不该再跟一次：这一串已经跟过了。
    onebot.push(groupText('6', { userId: 4444444444, card: 'mutsumi', messageId: 92 }));
    onebot.push(groupText('6', { userId: 5555555555, name: 'anon', card: 'anon', messageId: 93 }));
    onebot.push(groupText('6', { userId: 6666666666, name: 'soyo', card: 'soyo', messageId: 94 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), ['6'], '一串只跟一次，不该连发第二条');

    // 有人说了别的：链被打断，下一串要重新攒（两条相同的才又跟一次）。
    onebot.push(groupText('7', { userId: 7777777777, name: 'taki', card: 'taki', messageId: 95 }));
    await settle();
    onebot.push(groupText('6', { userId: 8888888888, name: 'tomori', card: 'tomori', messageId: 96 }));
    await settle();
    assert.deepEqual(sentTexts(onebot), ['6'], '单独一条不算「连着」');

    onebot.push(groupText('6', { userId: 9999999999, name: 'rikki', card: 'rikki', messageId: 97 }));
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
      sender: { nickname: 'soyo' },
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

/** 「群里有人只发了一张图」。默认是一张收藏表情（NapCat 上报的 `sub_type: 1`）。 */
function groupSticker(url, { messageId = 7000, userId = 100000003, card = 'kaguya', summary = '[动画表情]', file = 'A.png', subType = 1 } = {}) {
  return groupMessage([{ type: 'image', data: { summary, file, url, sub_type: subType } }], { messageId, userId, card });
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
    // 复读要原样接上：原消息是表情，发回去也得带 QQ 的大表情标记（否则群里看到的是
    // 照片样式的图片，一眼就不是人发的表情）。
    assert.equal(sent.params.message[0].data.sub_type, 1);
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

// 用例：复读按**原消息的样子**发 —— 原消息是表情就带大表情标记，是普通图片就不带。
// 群里两种「图」混着出现很正常：截图/照片不能标成表情（会被 QQ 按表情裁小），
// 而带 `emoji_id` 的商城表情（NapCat 把它折成 image 段，没有 sub_type）要按表情发回去。
test('a repeated picture keeps its kind: sticker stays a sticker, photo stays a photo', async () => {
  const images = await startImageServer(TINY_PNG);
  // 第二段用**另一张图**：同一张图在第一段已经跟过一次了，而「一串只跟一次」之后
  // 再来同一张不会再跟（这里验的是「表情按表情发」，不是复读的触发条件）。
  const market = await startImageServer(OTHER_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  const groupSends = () => onebot.calls.filter((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message));
  try {
    // 普通图片：NapCat 上报 `sub_type: 0`。复读出去仍是普通图片。
    onebot.push(groupSticker(images.url(), { messageId: 142, subType: 0 }));
    onebot.push(groupSticker(images.url(), { messageId: 143, userId: 3333333333, card: 'iroha', subType: 0 }));
    await until(() => groupSends().length >= 1, 'the repeated picture');
    assert.equal(groupSends()[0].params.message[0].data.sub_type, undefined);

    // 商城表情：NapCat 折成 `image` + `emoji_id`（没有 sub_type）。复读按表情发。
    const marketFace = (messageId, userId, card) => groupMessage(
      [{ type: 'image', data: { summary: '猫猫', file: 'A.gif', url: market.url(), emoji_id: '42' } }],
      { messageId, userId, card },
    );
    onebot.push(marketFace(144, 100000003, 'kaguya'));
    onebot.push(marketFace(145, 3333333333, 'iroha'));
    await until(() => groupSends().length >= 2, 'the repeated market face');
    assert.equal(groupSends()[1].params.message[0].data.sub_type, 1);
  } finally {
    await onebot.close();
    await images.close();
    await market.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

// 用例：同一张图先以表情出现、后以普通图片出现（另存 / 转发会这样），复读仍按表情发 ——
// `sticker` 在链上累加（`repeatStep` 里的 OR），不是只看触发复读的最后一条。
// 真实事故：19:53 一条表情、19:54 同一张图被当成图片又发一遍，复读跟成了照片样式的图。
test('a sticker chain stays a sticker even when the last one is a picture', async () => {
  const images = await startImageServer(TINY_PNG);
  const mediaRoot = await mkdtemp(join(tmpdir(), 'qq-media-'));
  const { onebot } = await boot({ cwd: mediaRoot, mediaDir: 'media' });
  const groupSends = () => onebot.calls.filter((call) => call.action === 'send_group_msg' && Array.isArray(call.params.message));
  try {
    onebot.push(groupSticker(images.url(), { messageId: 146, subType: 1 }));
    onebot.push(groupSticker(images.url(), { messageId: 147, userId: 3333333333, card: 'iroha', subType: 0, summary: '' }));
    await until(() => groupSends().length >= 1, 'the repeated sticker');
    assert.equal(groupSends()[0].params.message[0].data.sub_type, 1);
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
    onebot.push(groupText('6', { messageId: 154, userId: 5555555555, card: 'anon' }));
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
    const agent = await untilInbox(host, 1, 'the Agent');
    const started = Date.now();
    completeTurn(host, agent, reply);

    const sent = await until(() => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.length === 3 ? list : undefined;
    }, 'the burst to be delivered');
    // 短气泡句末的「。」在发送前被剥掉（stripShortPeriod）；问号/感叹号不动。
    assert.deepEqual(sent, ['今天天气不错', '要不出去走走？', '顺便吃个饭吧！']);
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
    const agent = await untilInbox(host, 1, 'the Agent');
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

// 聊天型 / 信息型都按模型写的条数发：没有条数上限，也没有「超出的并进最后一条」。
test('chat and informational replies both send every line the model wrote', async () => {
  const options = {
    burstMaxChars: 12,
    burstMaxParts: 3,
    burstMaxMessages: 0,
    burstSingleMaxChars: 20,
    readDelayMs: 0,
    minDelayMs: 0,
    maxDelayMs: 0,
    delayJitter: 0,
  };

  // 聊天型（去掉空白 7 字 ≤ 门槛 20）：两行就是两条，不会被并成一条。
  const short = await boot(options);
  try {
    short.onebot.push(privateMessage('在吗'));
    const agent = await until(() => short.host.list.created[0], 'the Agent');
    completeTurn(short.host, agent, '在的\n刚吃完');
    const sent = await until(() => {
      const list = sentTexts(short.onebot, 'send_private_msg');
      return list.length === 2 ? list : undefined;
    }, 'both chat bubbles');
    assert.deepEqual(sent, ['在的', '刚吃完']);
  } finally {
    await short.onebot.close();
  }

  // 信息型（去掉空白 28 字 > 门槛 20）：换行照旧分条，一行一条短句。
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

// 没有掷骰、也没有条数上限：模型写五条就发五条（旧版本默认最多 3 条，超出的并进最后一条）。
test('bubble count has no cap: five lines become five messages', async () => {
  const { onebot, host } = await boot({ readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0 });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    completeTurn(host, agent, '在的\n刚吃完\n你呢\n要不要出去走走\n顺便吃个饭');
    const sent = await until(() => {
      const list = sentTexts(onebot, 'send_private_msg');
      return list.length === 5 ? list : undefined;
    }, 'all five bubbles');
    assert.deepEqual(sent, ['在的', '刚吃完', '你呢', '要不要出去走走', '顺便吃个饭']);
  } finally {
    await onebot.close();
  }
});

// 标点清洗：短气泡句末的「。」在发送前剥掉；长气泡保留正常标点。
test('stripShortPeriod removes the trailing full stop of a short bubble', async () => {
  const { onebot, host } = await boot({ readDelayMs: 0, minDelayMs: 0, maxDelayMs: 0, delayJitter: 0, shortPeriodMaxChars: 40 });
  try {
    onebot.push(privateMessage('在吗'));
    const agent = await until(() => host.list.created[0], 'the Agent');
    completeTurn(host, agent, '在的。');
    await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the reply');
    assert.deepEqual(sentTexts(onebot, 'send_private_msg'), ['在的']);
  } finally {
    await onebot.close();
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
    const agent = await untilInbox(host, 1, 'the group Agent');
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

// 用例十七之二·补：中间隔着**机器人自己刚发的话**时也要引用。
//
// 真实日志里的样子（group:100000001，15:33）：iroha 问天气（第 44 轮，入站时快照 S）→ 三秒后
// 另一个人发来一张表情包（第 45 轮，快照 S+1）→ 第 44 轮的回复「桂林今天多云…」发出去
// （我在这个群里说了话，进度 S+2）→ 第 45 轮回「又发我照片干嘛」时，被回的那张图后面已经
// 多了一条**我自己的**消息，得带引用才看得出来在回哪条。
//
// 这一票是在 `sendOne` 里发的，不是等回灌：NapCat 的 `reportSelfMessage` 关着，自己发出的
// 消息不会作为事件回来，所以用例里也只推别人的消息、靠真发出去的那条回复推动进度。
test("auto reply style also counts the bot's own replies in between", async () => {
  const { onebot, host } = await boot({ replyStyle: 'auto' });
  try {
    // 第 44 轮：iroha 问天气；不等它回完，紧接着又来一条（这条排在下一轮）。
    onebot.push(mention('今天桂林天气怎么样', { messageId: 4241 }));
    const agent = await until(() => host.list.created[0], 'the group Agent');
    await until(() => agent.inbox.length === 1, 'the weather question to reach the Agent');
    onebot.push(mention('又发我照片', { messageId: 4242 }));
    await until(() => agent.inbox.length === 2, 'the second message to queue up behind it');

    // 第 44 轮正常发完：这时候群里已经出现了我自己的话（「被回的那条被挤远」）。
    const session = { id: agent.id };
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 44 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 44, step: 1, message: { content: [{ type: 'text', text: '桂林今天多云，23到34度' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 44, reason: { kind: 'completed' } } });
    // 问天气的时候另一个人插了一句，所以第 44 轮自己就带引用。
    assert.deepEqual(await until(() => sentTexts(onebot)[0], 'the weather reply'), [
      { type: 'reply', data: { id: '4241' } },
      { type: 'text', data: { text: '桂林今天多云，23到34度' } },
    ]);

    // 第 45 轮回那张照片：中间只多了我自己那句话，也得点名。
    host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[1], turn: 45 });
    host.list.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 45, step: 1, message: { content: [{ type: 'text', text: '又发我照片干嘛' }] } },
    });
    host.list.emit('session/event', session, { type: 'turn/end', data: { turn: 45, reason: { kind: 'completed' } } });
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted second reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4242' } },
      { type: 'text', data: { text: '又发我照片干嘛' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例十七之四：被回复的那条本身只有表情时不引用，带文字的表情照旧引用。
test('a reply never quotes a message that is only an emoji', async () => {
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    // 只有表情（系统表情 face 段）：引用块会把那张表情再贴一遍，所以裸文本回。
    onebot.push(groupMessage(
      [{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'face', data: { id: '13' } }],
      { messageId: 4250 },
    ));
    const agent = await untilInbox(host, 1, 'the emoji-only message');
    completeTurn(host, agent, '？', 1);
    assert.equal(await until(() => sentTexts(onebot)[0], 'the plain reply'), '？');

    // 文字 + 表情：文字才是可以接的话头，引用照旧。
    onebot.push(groupMessage(
      [
        { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
        { type: 'text', data: { text: '笑死' } },
        { type: 'face', data: { id: '13' } },
      ],
      { messageId: 4251 },
    ));
    await until(() => agent.inbox.length === 2, 'the second message');
    completeTurn(host, agent, '确实', 2);
    const sent = await until(() => sentTexts(onebot)[1], 'the quoted reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '4251' } },
      { type: 'text', data: { text: '确实' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例十七之三：一次回复里的换行拆成多条独立消息，且引用只挂在第一条上。
test('a multiline group reply becomes separate messages with the quote only on the first', async () => {
  // 这条用例验的是「换行 = 分条 + 引用只挂第一个文字气泡」；条数上限与并条是另一组用例。
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 4242 }));
    const agent = await untilInbox(host, 1, 'the group Agent');
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

// 用例：回复里可以 @ 别人（`[[@昵称]]` → at 段），而正文里**不会**出现 QQ 号。
//
// 这一组的出发点是「模型看不见、也不该写出任何 QQ 号」：提示词里只给它昵称，
// 它想点名就写 `[[@昵称]]`，插件负责换成真正的 at 段。
test('a reply can @ somebody by nickname, and raw QQ numbers never reach the chat', async () => {
  const { onebot, host } = await boot({ replyStyle: 'plain' });
  try {
    // 第一个人 @ 了它，第二个人的名字要靠环境上下文/自己发言进名单。
    onebot.push(mention('在吗', { messageId: 5001, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '[[@kaguya]] 在的', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the mentioned reply');
    assert.deepEqual(sent, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 在的' } },
    ]);

    // 认不出来的名字：整个标记丢掉，绝不会把 `[[@…]]` 原样糊进群里。
    onebot.push(mention('还有人吗', { messageId: 5002 }));
    await until(() => agent.inbox.length === 2, 'the second message');
    completeTurn(host, agent, '[[@查无此人]] 没别人了', 2);
    const second = await until(() => sentTexts(onebot)[1], 'the reply with an unknown name');
    assert.deepEqual(second, [{ type: 'text', data: { text: ' 没别人了' } }]);
    assert.ok(!JSON.stringify(second).includes('[['), JSON.stringify(second));

    // 整条回复只有一个没法解析的 @：什么都不发（而不是发一串乱码）。
    onebot.push(mention('你倒是说啊', { messageId: 5003 }));
    await until(() => agent.inbox.length === 3, 'the third message');
    completeTurn(host, agent, '[[@查无此人]]', 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sentTexts(onebot).length, 2);

    // 整条回复只有一个**解析得出来**的 @：只发一个 at 段，一个字都不说。
    onebot.push(mention('叫我干嘛', { messageId: 5004 }));
    await until(() => agent.inbox.length === 4, 'the fourth message');
    completeTurn(host, agent, '[[@kaguya]]', 4);
    const onlyAt = await until(() => sentTexts(onebot)[2], 'the @-only reply');
    assert.deepEqual(onlyAt, [{ type: 'at', data: { qq: '100000003' } }]);

    // `[[@全体成员]]` 是群里唯一认的「所有人」，且不依赖名单。
    onebot.push(mention('通知一下', { messageId: 5005 }));
    await until(() => agent.inbox.length === 5, 'the fifth message');
    completeTurn(host, agent, '[[@全体成员]] 都来看看这个', 5);
    const everyone = await until(() => sentTexts(onebot)[3], 'the all-mention reply');
    assert.deepEqual(everyone, [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 都来看看这个' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例：@ 的名单按会话隔离 —— 一个人在群里说过话，不代表能在私聊里 @ 到他。
test('the @ list is per conversation: a group member is not mentionable in a private chat', async () => {
  const { onebot, host } = await boot({ replyStyle: 'plain' });
  try {
    // 先在群里认识 kaguya（他 @ 了机器人）。
    onebot.push(mention('在吗', { messageId: 5101, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    await untilInbox(host, 1, 'the group Agent');
    // 私聊里对方是另一个人，kaguya 不在这个会话的名单里。
    onebot.push(privateMessage('你好'));
    // 等它**并且**等消息落进它的收件箱：只看 `created` 会抢在 followup 之前拿到 Agent，
    // 于是 completeTurn 拿着 `message: undefined` 去开 turn（AGENTS §8 那条竞态）。
    const priv = await until(
      () => host.list.created.find((entry) => entry.id !== host.list.created[0].id && entry.inbox.length >= 1),
      'the private Agent to receive its message',
    );
    completeTurn(host, priv, '[[@kaguya]] 你好', 1);
    const sent = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the private reply');
    // 私聊里也没有「全体成员」这回事：都解析不出来，于是只剩正文。
    assert.deepEqual(sent, [{ type: 'text', data: { text: ' 你好' } }]);
  } finally {
    await onebot.close();
  }
});

// 用例：@ 标记与引用指向可以同时挂在同一条消息上（顺序是「先指向、后正文」）。
test('an @ in the reply keeps the quote head in front of it', async () => {
  const { onebot, host } = await boot({ replyStyle: 'quote' });
  try {
    onebot.push(mention('在吗', { messageId: 5201, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    const agent = await untilInbox(host, 1, 'the group Agent');
    completeTurn(host, agent, '[[@kaguya]] 在的', 1);
    const sent = await until(() => sentTexts(onebot)[0], 'the reply');
    assert.deepEqual(sent, [
      { type: 'reply', data: { id: '5201' } },
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 在的' } },
    ]);
  } finally {
    await onebot.close();
  }
});

// 用例：出站工具（qq_send_message）也能 @ 人 —— 但它只认得「这个会话聊过的人」。
test('qq_send_message resolves [[@nickname]] against the conversation it is sending to', async () => {
  const { onebot, host } = await boot();
  try {
    const tool = host.tools.get('qq_send_message');
    // 先从 QQ 会话里认识 kaguya（他在群里 @ 了机器人）。
    onebot.push(mention('在吗', { messageId: 5301, userId: 100000003, name: 'tomori', card: 'kaguya' }));
    await until(() => host.list.created[0], 'the group Agent');
    // 工具是 Agent 的显式动作：这里直接调用，模拟模型点名要 @ 群里的人。
    const value = await tool.execute({ target_type: 'group', target_id: '100000001', message: '[[@kaguya]] 出来说话' }, {});
    assert.deepEqual(value, { target_type: 'group', target_id: '100000001', parts: 1 });
    const sent = onebot.calls.filter((call) => call.action === 'send_group_msg').at(-1);
    assert.deepEqual(sent.params.message, [
      { type: 'at', data: { qq: '100000003' } },
      { type: 'text', data: { text: ' 出来说话' } },
    ]);

    // 一个从没聊过的群：名单是空的，@ 解析不出来 —— 退化成纯文本，而不是报错。
    const stranger = await tool.execute({ target_type: 'group', target_id: '999999999', message: '[[@kaguya]] 在吗' }, {});
    assert.equal(stranger.parts, 1);
    const last = onebot.calls.filter((call) => call.action === 'send_group_msg').at(-1);
    assert.deepEqual(last.params.message, [{ type: 'text', data: { text: ' 在吗' } }]);
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
    const firstContext = turnContextText(agent);
    assert.ok(firstContext.includes('刚跟你说话的人：kaguya'), firstContext);

    onebot.push(mention('还在吗', { messageId: 12, userId: 333, name: 'iroha', card: 'iroha' }));
    await until(() => agent.inbox.length === 2, 'the second message to be delivered');
    const second = await until(() => {
      const text = turnContextText(agent);
      return text.includes('刚跟你说话的人：iroha') ? text : undefined;
    }, 'the prompt to name the new speaker');
    // 群名没有被下一条消息冲成空串（系统小节仍然稳定）。
    const afterSecond = promptText(host, 'qq-bridge:channel');
    assert.ok(afterSecond.includes('示例群'), afterSecond);
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

// 用例十九之三：入站段「是不是表情」只认结构字段 —— 复读要不要按大表情发的判据。
test('isStickerSegment only trusts structural fields', () => {
  // 收藏表情 / 大表情：NapCat 把 QQ 的 picSubType 原样放进 sub_type（非 0 就是表情）。
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 1 } }), true);
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 2 } }), true);
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: '1' } }), true);
  // 商城表情：NapCat 上报时折成 image 段 + emoji_id（没有 sub_type）。
  assert.equal(isStickerSegment({ type: 'image', data: { emoji_id: '42' } }), true);
  // mface 段本身就是商城表情。
  assert.equal(isStickerSegment({ type: 'mface', data: { emoji_id: '42' } }), true);
  // 普通图片（0）与别的段一律不是表情；字段缺失也不能猜成表情。
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 0 } }), false);
  assert.equal(isStickerSegment({ type: 'image', data: {} }), false);
  assert.equal(isStickerSegment({ type: 'image' }), false);
  assert.equal(isStickerSegment({ type: 'face', data: { id: '13' } }), false);
  assert.equal(isStickerSegment(undefined), false);
});

// 用例十九之四：被回复的那条「是不是只有表情」—— 回复它时不挂引用的判据。
test('isEmojiOnlyMessage trusts structural fields and requires the absence of text', () => {
  // 只有表情：表情包 / 商城表情 / 系统表情，都算。
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { sub_type: 1 } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { emoji_id: '42' } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'mface', data: { emoji_id: '42' } }]), true);
  assert.equal(isEmojiOnlyMessage([{ type: 'face', data: { id: '13' } }]), true);
  // @ / reply 段是元信息，不影响「有没有字」的判断：@ 完发一张表情仍然只是表情。
  assert.equal(isEmojiOnlyMessage([
    { type: 'at', data: { qq: '100000002' } },
    { type: 'face', data: { id: '13' } },
  ]), true);
  assert.equal(isEmojiOnlyMessage([
    { type: 'reply', data: { id: '9' } },
    { type: 'image', data: { sub_type: 1 } },
  ]), true);
  // 带文字的就不算：文字才是可以「接」的话头，引用它是有意义的。
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '笑死' } }, { type: 'face', data: { id: '13' } }]), false);
  // 纯空白文字不算「有字」：空白不是可以接的话头。
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '   ' } }, { type: 'face', data: { id: '13' } }]), true);
  // 普通图片 / 语音 / 纯文字 / 字符串形态：都不是「只有表情」。
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: { sub_type: 0 } }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'image', data: {} }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '[CQ:face,id=13]' } }]), false);
  assert.equal(isEmojiOnlyMessage([{ type: 'text', data: { text: '在吗' } }]), false);
  assert.equal(isEmojiOnlyMessage('[CQ:face,id=13]'), false);
  assert.equal(isEmojiOnlyMessage([]), false);
  assert.equal(isEmojiOnlyMessage(undefined), false);
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
    const agent = await until(() => host.list.created[0], 'the group Agent');
    const prompt = await until(
      () => (/kaguya: \[图片\(动画表情\): (media\/[0-9a-f]{32}\.png)\]/.exec(turnContextText(agent)) ?? undefined),
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
    const prompt = turnContextText(quiet.host.list.created[0]);
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
    // 普通图片不带 sub_type；收藏目录里的表情带 1（QQ 的大表情 / 原创表情），
    // 不带的话群里看到的是一张照片样式的图片，一眼不像人发的表情。
    assert.equal(segment.data.sub_type, undefined);
    const sticker = imageSegment(TINY_PNG, { sticker: true });
    assert.equal(sticker.type, 'image');
    assert.equal(sticker.data.sub_type, 1);
    assert.match(sticker.data.file, /^base64:\/\//);
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
  // 收藏目录里的表情走「大表情」标记；`qq_send_image` 发别的图时不能带（见下一条用例）。
  assert.equal(sent.params.message[0].data.sub_type, 1);
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
    // `.qq-media` 里的图可能是截图或照片，绝不能标成 QQ 的大表情（会被裁成小图）。
    assert.equal(sent.params.message[0].data.sub_type, undefined);
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
  assert.equal(sent.params.message[0].data.sub_type, 1);
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

// ---- 存表情包：qq_save_sticker -------------------------------------------------
// 为什么需要这个工具：QQ 会话按设计没有 write / edit / bash（那三样在不可信输入面上
// 太危险），于是群里最常见的那句「存一下这个表情」模型**自己做不到**。真实发生过的
// 样子是它 `read_image` 看完、`glob .qq-stickers/**` 发现空的，只能把含义追加进
// `COGNITION.md`、key 写成 `.qq-media/<内容哈希>`（一个会被淘汰的缓存路径），然后回一句
// 「存好了」。这一组钉住的是：存下去的是**原字节**、名字被洗成单层、目录满了/同名了会拒绝，
// 以及存完下一轮提示词里就能挑到它。

test('qq_save_sticker keeps a picture the conversation posted and it shows up in the pack', async () => {
  const images = await startImageServer(TINY_PNG);
  const { onebot, host, cwd } = await bootImages();
  try {
    onebot.push(privateMessageWithImage(images.url(), { text: '存一下这个' }));
    const agent = await until(() => host.list.created[0], 'the conversation Agent');
    const body = await until(() => agent.inbox[0]?.content[0]?.text, 'the message body to reach the Agent');
    const source = /\[图片\(动画表情\): ([^\]]+)\]/.exec(body)?.[1];
    assert.ok(source, body);

    const value = await host.tools.get('qq_save_sticker').execute({ source, name: '委屈', meaning: '委屈、求安慰' }, { agent });
    assert.equal(value.path, '.qq-stickers/委屈.png');
    assert.equal(value.format, 'png');
    assert.equal(value.bytes, TINY_PNG.length);
    // 落盘的必须是原字节：这张图以后要原样发回去，转码过就不是同一张表情了。
    assert.deepEqual(await readFile(join(cwd, '.qq-stickers', '委屈.png')), TINY_PNG);
    // 提示词每次装配都重新读目录，所以不用重启就该列出来。条目必须带上**完整路径**：
    // 只给名字的话模型会自己猜扩展名（真实事故：敲盆.gif 被写成敲盆.jpg，发送侧找不到）。
    assert.match(promptText(host, 'qq-bridge:channel'), /委屈（委屈、求安慰） → \.qq-stickers\/委屈\.png/);
    // 存下来的唯一用途就是发出去：裸文件名（不带扩展名）也该认得出来。
    const sent = await host.tools.get('qq_send_image').execute({ image: '委屈' }, { agent });
    assert.equal(sent.source, '.qq-stickers/委屈.png');
  } finally {
    await onebot.close();
    await images.close();
  }
});

test('qq_save_sticker refuses non-images, outside paths, unusable names, and overwrites', async () => {
  const { onebot, host, cwd } = await bootImages();
  try {
    const tool = host.tools.get('qq_save_sticker');
    await assert.rejects(() => tool.execute({ source: 'notes.txt', name: '笔记' }, {}), /not a PNG\/JPEG\/WebP\/GIF/);
    await assert.rejects(() => tool.execute({ source: '../../etc/hostname', name: '越界' }, {}), /inside the working directory/);
    // 名字清洗完什么都不剩时必须报错，而不是写一个 `.png` 这种残名进去。
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '..' }, {}), /not a usable sticker name/);
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '\u0000' }, {}), /not a usable sticker name/);
    // 同名**绝不覆盖**：不然群里任何人一句「存一下」就能把现有表情换掉。
    await assert.rejects(() => tool.execute({ source: '.qq-stickers/笑死.png', name: '笑死' }, {}), /already exists/);
    // 一次都没写成功：所有校验都发生在动目录之前。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['笑死.png']);
  } finally {
    await onebot.close();
  }
});

test('qq_save_sticker stops at imageMaxBytes and at stickerMaxFiles', async () => {
  // 太大的图先被 imageMaxBytes 挡住（与发图同一条校验）。
  const big = await bootImages({ imageMaxBytes: 32 });
  await assert.rejects(() => big.host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '大图' }, {}), /larger than 32 bytes/);
  await big.onebot.close();

  // 目录里已经有 1 张、上限也是 1：QQ 那头能一直让它存，所以必须在这里截断。
  const capped = await bootImages({ stickerMaxFiles: 1 });
  try {
    await assert.rejects(
      () => capped.host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '再一张' }, {}),
      /already holds 1 images/,
    );
  } finally {
    await capped.onebot.close();
  }
});

test('qq_save_sticker is not registered when the sticker directory or its whitelist slot is missing', async () => {
  // 目录配到 cwd 外 = 表情包功能整体停用（只记 warn）：不给模型一个必然报错的工具。
  const outside = await bootImages({ stickerDir: '../stickers' });
  try {
    outside.onebot.push(privateMessage('在吗'));
    await until(() => outside.host.list.created[0], 'the outside Agent');
    assert.equal(outside.host.tools.get('qq_save_sticker'), undefined);
    assert.doesNotMatch(promptText(outside.host, 'qq-bridge:channel'), /qq_save_sticker/);
  } finally {
    await outside.onebot.close();
  }

  // 白名单里没有它（这里只给 read）时同样不注册 —— 白名单只能收窄，漏一层就等于没收。
  const restricted = await bootImages({ allowTools: ['read'] }, { knownTools: ['read', 'qq_send_image', 'qq_save_sticker'] });
  try {
    restricted.onebot.push(privateMessage('在吗'));
    await until(() => restricted.host.list.created[0], 'the restricted Agent');
    assert.equal(restricted.host.tools.get('qq_save_sticker'), undefined);
    assert.doesNotMatch(promptText(restricted.host, 'qq-bridge:channel'), /qq_save_sticker/);
  } finally {
    await restricted.onebot.close();
  }
});

// ---- 给表情包改名：qq_rename_sticker -------------------------------------------
// 这个工具的来历就是一条真实事故：模型想改一张表情的名字 / 含义时，手上只有
// `qq_save_sticker` 这一条写盘通道，于是它把同一张图**换个名字再存一遍** ——
// `.qq-stickers/` 里多出一张同画面、不同名的重复表情，`STICKERS.md` 里旧名字那条
// 还留着，两张以后都会被挑中，而它自己没有删文件的通道。改名必须是「同一个文件换
// 个名字、目录那一条跟着搬」，这一组钉住的就是：文件真的搬了、目录没有旧条目、
// 含义 / 场景 / 日期不丢、目标名占用时拒绝、失败时不留半套。

test('qq_rename_sticker moves the file and its catalogue row together', async () => {
  const { onebot, host, cwd } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');
  try {
    const save = host.tools.get('qq_save_sticker');
    await save.execute({ source: '.qq-stickers/笑死.png', name: '委屈', meaning: '委屈、求安慰', scene: '对方凶我时' }, { agent });

    const renamed = await host.tools.get('qq_rename_sticker').execute({ from: '委屈', to: '难过' }, { agent });
    assert.equal(renamed.previous, '.qq-stickers/委屈.png');
    assert.equal(renamed.path, '.qq-stickers/难过.png');
    assert.equal(renamed.renamed, true);
    assert.equal(renamed.bytes, TINY_PNG.length);
    // 文件是**搬过去**的：旧名字不在了，也不该多出一张同画面的副本。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['笑死.png', '难过.png']);
    assert.deepEqual(await readFile(join(cwd, '.qq-stickers', '难过.png')), TINY_PNG, '改的是名字，不是字节');
    // 目录那一条跟着搬：含义 / 场景 / 路径都在新名字下，旧名字一条不剩。
    const prompt = promptText(host, 'qq-bridge:channel');
    assert.match(prompt, /难过（委屈、求安慰） → \.qq-stickers\/难过\.png/);
    assert.doesNotMatch(prompt, /委屈（/);
    // 发图那条路认得新名字（旧名字的裸名字解析已经不指向任何文件）。
    const sent = await host.tools.get('qq_send_image').execute({ image: '难过' }, { agent });
    assert.equal(sent.source, '.qq-stickers/难过.png');
    // 旧名字再改一次就该明确报错（而不是悄悄追加一条新的）。
    await assert.rejects(() => host.tools.get('qq_rename_sticker').execute({ from: '委屈', to: '更难过' }, { agent }), /没有「委屈」/);
  } finally {
    await onebot.close();
  }
});

test('qq_rename_sticker refuses taken names and unusable names', async () => {
  const { onebot, host, cwd } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');
  try {
    const rename = () => host.tools.get('qq_rename_sticker');
    // 改成同一个名字是空操作（不报错，也不该搬文件）。
    const same = await rename().execute({ from: '笑死', to: '笑死' }, { agent });
    assert.equal(same.renamed, false);
    await host.tools.get('qq_save_sticker').execute({ source: '.qq-stickers/笑死.png', name: '委屈', meaning: '委屈、求安慰' }, { agent });
    // 目标名已被占用（目录里本来就有 笑死.png）：与「同名不覆盖」同一条理由。
    await assert.rejects(() => rename().execute({ from: '委屈', to: '笑死' }, { agent }), /already exists/);
    // 名字清洗完什么都不剩：必须报错，而不是搬成 `.png`。
    await assert.rejects(() => rename().execute({ from: '委屈', to: '..' }, { agent }), /not a usable sticker name/);
    // 找不到来源：说清目录里有哪些，别让模型去猜。
    await assert.rejects(() => rename().execute({ from: '不存在的表情', to: '新名字' }, { agent }), /没有「不存在的表情」/);
    // 一次都没动过目录。
    assert.deepEqual((await readdir(join(cwd, '.qq-stickers'))).sort(), ['委屈.png', '笑死.png']);
    assert.match(promptText(host, 'qq-bridge:channel'), /委屈（委屈、求安慰） → \.qq-stickers\/委屈\.png/);
  } finally {
    await onebot.close();
  }
});

test('qq_rename_sticker is not registered without the sticker directory or its whitelist slot', async () => {
  const outside = await bootImages({ stickerDir: '../stickers' });
  try {
    outside.onebot.push(privateMessage('在吗'));
    await until(() => outside.host.list.created[0], 'the outside Agent');
    assert.equal(outside.host.tools.get('qq_rename_sticker'), undefined);
    assert.doesNotMatch(promptText(outside.host, 'qq-bridge:channel'), /qq_rename_sticker/);
  } finally {
    await outside.onebot.close();
  }

  // 只整理不新增：存图关掉、改名单独放开 —— 白名单是逐名字的，不应该被别的工具连坐。
  const restricted = await bootImages(
    { allowTools: ['read', 'qq_send_image', 'qq_rename_sticker'] },
    { knownTools: ['read', 'qq_send_image', 'qq_save_sticker', 'qq_rename_sticker'] },
  );
  try {
    restricted.onebot.push(privateMessage('在吗'));
    await until(() => restricted.host.list.created[0], 'the rename-only Agent');
    assert.equal(restricted.host.tools.get('qq_save_sticker'), undefined);
    assert.ok(restricted.host.tools.get('qq_rename_sticker'), '改名不该被存图的白名单连坐');
  } finally {
    await restricted.onebot.close();
  }
});

test('the channel prompt offers qq_send_image and lists the sticker pack', async () => {
  const on = await bootImages();
  on.onebot.push(privateMessage('在吗'));
  await until(() => on.host.list.created[0], 'the first Agent');
  const prompt = promptText(on.host, 'qq-bridge:channel');
  assert.match(prompt, /qq_send_image/);
  assert.match(prompt, /\.qq-stickers\/笑死\.png/);
  // 「存一下这个」是群里最常出现的一句，提示词必须把那条窄通道说清楚。
  assert.match(prompt, /qq_save_sticker/);

  // 白名单挡掉这个工具时，提示词里一个字都不能再提它。
  const off = await bootImages(
    { allowTools: ['read'] },
    { knownTools: ['qq_send_message', 'qq_send_image', 'qq_list_conversations', 'read'] },
  );
  off.onebot.push(privateMessage('在吗'));
  await until(() => off.host.list.created[0], 'the second Agent');
  const hidden = promptText(off.host, 'qq-bridge:channel');
  assert.doesNotMatch(hidden, /qq_send_image/);
  assert.doesNotMatch(hidden, /qq_save_sticker/);
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
    const agent = await untilInbox(host, 1, 'the Agent');

    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const sent = await until(
      () => onebot.calls.find((call) => call.action === 'send_private_msg' && Array.isArray(call.params.message)),
      'the sticker to reach QQ',
    );
    assert.equal(sent.params.user_id, '100000002');
    assert.equal(sent.params.message.length, 1);
    assert.equal(sent.params.message[0].type, 'image');
    // 收藏目录里的表情按 QQ 的「大表情」发（真人从表情面板发出来的那些也是这样）。
    assert.equal(sent.params.message[0].data.sub_type, 1);
    assert.deepEqual(Buffer.from(sent.params.message[0].data.file.replace('base64://', ''), 'base64'), TINY_PNG);
    // 一条文字都没有：整轮只发了这一条。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(onebot.calls.filter((call) => call.action === 'send_private_msg').length, 1);
    await onebot.close();
  }
});

test('a sticker written as a bare file name or with the wrong extension is still found', async () => {
  // 提示词里给的是 `.qq-stickers/笑死.png`，但模型很可能只写 `笑死` / `笑死.png`，
  // 或者把扩展名猜错（目录里 .jpg 比 .gif 多，真实事故：敲盆.gif 被写成敲盆.jpg）。
  // 落空的话群里只会看到一句「表情包没发出去」，所以这些写法都先在表情包目录里找回来。
  for (const source of ['笑死', '笑死.png', '.qq-stickers/笑死.png', '笑死.gif', '.qq-stickers/笑死.gif']) {
    const { onebot, host } = await bootImages();
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');

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
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '先说我一句\n[[图片: .qq-stickers/笑死.png]]\n再补一句');
  const calls = await until(() => {
    const sent = onebot.calls.filter((call) => call.action === 'send_private_msg');
    return sent.length >= 3 ? sent : undefined;
  }, 'the three messages');
  assert.equal(calls[0].params.message, '先说我一句');
  assert.equal(calls[1].params.message[0].type, 'image');
  assert.equal(calls[2].params.message, '再补一句');
});

test('an image never carries the reply target, and a sticker-only reply drops the quote', async () => {
  // §6.6：引用只挂第一个**文字**气泡，图段永不挂；整轮只有图时引用直接丢弃。
  // 「表情本身就是一个反应」，给它挂一条引用反而像在慎重地回复某句话。
  const { onebot, host } = await bootImages({ replyStyle: 'quote' }, {}, {});
  onebot.push(mention('来一张'));
  const agent = await untilInbox(host, 1, 'the group Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
  const sent = await until(() => onebot.calls.find((call) => call.action === 'send_group_msg'), 'the group message');
  assert.equal(sent.params.message.length, 1, '只有图，没有任何前面挂的段');
  assert.equal(sent.params.message[0].type, 'image');
});

test('a sticker that cannot be sent says so instead of going silent', async () => {
  const { onebot, host } = await bootImages();
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '[[图片: .qq-stickers/nope.png]]');
  const sent = await until(
    () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('发不出去')),
    'the notice to reach QQ',
  );
  assert.match(sent, /发不出去/);
  // 一张图都没发出去。
  assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
  assert.ok(host.list.warnings.some((line) => line.includes('nope.png')), host.list.warnings.join('|'));
  // 失败必须回灌到**下一轮的情境**里：模型才看得到「那张没发出去、为什么」，
  // 否则它会照着自己编的路径再编一个（真实事故：连编两轮 `.qq-media` 哈希）。
  onebot.push(privateMessage('再试一次'));
  await untilInbox(host, 2, 'the follow-up turn');
  const prompt = turnContextText(agent);
  assert.match(prompt, /nope\.png/);
  assert.match(prompt, /没发出去/);
});

test('发表情只认收藏目录：`.qq-media` 里真实存在的图也不能借标记发出去', async () => {
  const { onebot, host, cwd } = await bootImages();
  // 造一张**真实存在**的缓存图：旧事故里模型编的路径根本不存在，这里要证明的是
  // 「就算存在也不许发」—— 否则它迟早会挑到一张已经被人删掉的。
  await mkdir(join(cwd, '.qq-media'), { recursive: true });
  await writeFile(join(cwd, '.qq-media', 'abc123.png'), TINY_PNG);
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the Agent');

  completeTurn(host, agent, '[[图片: .qq-media/abc123.png]]');
  const sent = await until(
    () => sentTexts(onebot, 'send_private_msg').find((text) => text.includes('发不出去')),
    'the refusal notice',
  );
  assert.match(sent, /发不出去/);
  assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false, '一张图都不该发出去');
  onebot.push(privateMessage('再试一次'));
  await untilInbox(host, 2, 'the follow-up turn');
  const prompt = turnContextText(agent);
  assert.match(prompt, /只能从收藏目录/);
});

test('the marker stays literal text when image sending is off or whitelisted away', async () => {
  const cases = [
    { config: { imageSend: false }, hostOptions: {} },
    { config: { allowTools: ['read'] }, hostOptions: { knownTools: ['qq_send_image', 'read'] } },
  ];
  for (const { config, hostOptions } of cases) {
    const { onebot, host } = await bootImages(config, hostOptions);
    onebot.push(privateMessage('在吗'));
    const agent = await untilInbox(host, 1, 'the Agent');
    completeTurn(host, agent, '[[图片: .qq-stickers/笑死.png]]');
    const text = await until(() => sentTexts(onebot, 'send_private_msg')[0], 'the literal line');
    assert.equal(text, '[[图片: .qq-stickers/笑死.png]]');
    assert.equal(onebot.calls.some((call) => Array.isArray(call.params.message)), false);
    assert.doesNotMatch(promptText(host, 'qq-bridge:channel'), /\[\[图片/);
  }
});

// ---- 长期记忆：转录 → 工具 → 定时摘要 -------------------------------------------------

/**
 * 起一个开了长期记忆的实例：cwd 是新的临时目录，`.qq-memory` 就落在里面。
 *
 * 默认 `digestCatchUp: false` —— 补课会在第一条消息到达时就摘要一次，用例希望自己
 * 决定什么时候触发摘要（`host.list.timers.fireInterval()`）；要验补课就显式打开。
 */
async function bootMemory(config = {}, hostOptions = {}, onebotOptions = {}, seed) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-memory-'));
  // `seed` 在**插件 apply 之前**往 cwd 里铺文件：用来验启动期的一次性迁移
  // （PEOPLE.md 从各群 MEMORY.md 的「## 人」小节抽取）。
  if (typeof seed === 'function') await seed(cwd);
  return boot(
    // `proactive: false`：主动说话默认开着，它会多挂一个周期定时器；记忆这一组用例要数的
    // 是「摘要定时器」的个数，先把它关掉才能数得清。
    { memory: true, digestCatchUp: false, readDelayMs: 0, proactive: false, ...config, cwd },
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
  onebot.push(groupMessage([{ type: 'text', data: { text: '他们聊他们的' } }], { messageId: 7001, userId: 10001, card: 'soyo' }));
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
  assert.equal(groupLines[0].name, 'soyo');

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

  // 整份重写把条目砍掉一大截要 `force`（与认知库 / 表情包目录同一条护栏：
  // 模型漏抄几行时文件照样「写成功」，护栏是唯一能拦住它的地方）。
  await assert.rejects(
    () => tool.execute({ action: 'write', path: target, text: '- 只留这一条' }, {}),
    /keep only 1 of 2 entries/,
  );
  const overwritten = await tool.execute({ action: 'write', path: target, text: '- 只留这一条', force: true }, {});
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
test('qq_memory upsert / remove：逐条写认知与表情包，整份重写丢行会被挡住', async () => {
  const { host, cwd } = await bootMemory();
  const tool = host.tools.get('qq_memory');

  // 认知：新增 → 按 type 归节；同一条再写一次是「替换」，不是多加一行。
  const added = await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '蚌埠住了', meaning: '绷不住了', type: '谐音', variants: '绷不住/绷' }, {});
  assert.equal(added.action, 'upsert');
  assert.match(added.note, /added/);
  let cognition = await readMemory(cwd, 'COGNITION.md');
  assert.match(cognition, /## 谐音与变体\n- 蚌埠住了（变体：绷不住 \/ 绷）｜绷不住了/);

  const replaced = await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '蚌埠住了', meaning: '忍不住笑了', confidence: '存疑' }, {});
  assert.match(replaced.note, /replaced/);
  cognition = await readMemory(cwd, 'COGNITION.md');
  assert.equal((cognition.match(/蚌埠住了/g) ?? []).length, 1, '同一条不能变成两行');
  assert.match(cognition, /置信：存疑/);

  // 追加时又贴了一遍同一个标题：落盘时合并，文件里只留一个。
  await tool.execute({ action: 'append', path: 'COGNITION.md', text: '## 黑话与缩写\n- 典｜讽刺「经典操作」' }, {});
  await tool.execute({ action: 'append', path: 'COGNITION.md', text: '## 黑话与缩写\n- 急了｜破防了' }, {});
  cognition = await readMemory(cwd, 'COGNITION.md');
  assert.equal((cognition.match(/^## 黑话与缩写$/gm) ?? []).length, 1, '重复标题必须被合并');
  assert.match(cognition, /典｜/);
  assert.match(cognition, /急了｜/);

  const removed = await tool.execute({ action: 'remove', path: 'COGNITION.md', name: '蚌埠住了' }, {});
  assert.match(removed.note, /removed/);
  assert.doesNotMatch(await readMemory(cwd, 'COGNITION.md'), /蚌埠住了/);

  // 表情包：upsert 一条进「已收藏」，名字与路径由工具保证格式。
  await tool.execute({ action: 'upsert', path: 'STICKERS.md', name: '无语', meaning: '无语、懒得吐槽', image: '.qq-stickers/无语.gif' }, {});
  assert.match(await readMemory(cwd, 'STICKERS.md'), /## 已收藏\n- 无语/);

  // 护栏：整份重写把条目砍掉一大截 → 拒绝；`force: true` 才放行。
  await assert.rejects(
    () => tool.execute({ action: 'write', path: 'STICKERS.md', text: '# 表情包目录\n\n## 已收藏\n' }, {}),
    /keep only 0 of 1 entries/,
  );
  const forced = await tool.execute({ action: 'write', path: 'STICKERS.md', text: '# 表情包目录\n\n## 已收藏\n', force: true }, {});
  assert.equal(forced.action, 'write');

  // 解析不了的行：read 直接点出来（否则它永远不进提示词，谁都不会去修）。
  await tool.execute({ action: 'write', path: 'COGNITION.md', text: '# 公共认知\n\n## 黑话与缩写\n- 只有一段没有竖线\n', force: true }, {});
  const read = await tool.execute({ action: 'read', path: 'COGNITION.md' }, {});
  assert.match(read.note ?? '', /不会.*注入|不会被注入/);

  // 每次写入都把旧版本留在 `.history/` 里：整份重写写坏了还能人工翻回去。
  const history = await readdir(join(cwd, '.qq-memory', '.history')).catch(() => []);
  assert.ok(history.length > 0, '写前必须留历史版本');
  assert.ok(history.some((name) => name.startsWith('COGNITION.md.')), history.join('|'));
});

/** 定时器每天醒一次（默认 04:00），醒来帮会话摘要一次并记下进度。 */
test('a digest sweep summarizes a conversation that has something new', async () => {
  // `apiKeyRotate: false`：这条用例要数清楚「挂着几个定时器、排到几点」，
  // 而 API key 轮换默认开着、也排在 04:00，会一起出现在这张表里。
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 2, apiKeyRotate: false });
  onebot.push(privateMessage('第一条'));
  onebot.push(privateMessage('第二条'));
  await untilInbox(host, 1, 'the conversation Agent to be created');

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

/** `INDEX.md` 会出现在渠道提示里，好让模型「知道自己记得什么」。 */
test('the channel prompt carries the global INDEX.md once it exists', async () => {
  const { onebot, host, cwd } = await bootMemory();
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });
  await writeFile(join(cwd, '.qq-memory', 'INDEX.md'), '- kaguya：群主，周六常组织打本', 'utf8');
  onebot.push(privateMessage('在吗'));
  // 索引是异步刷新进缓存的（提示词装配是同步的），所以第一次装配可能还是空的。
  const agent = await until(() => host.list.created[0], 'the first Agent');
  const text = await until(() => {
    const current = turnContextText(agent);
    return current.includes('群主，周六常组织打本') ? current : undefined;
  }, 'the memory index to reach the channel prompt');
  assert.match(text, /和当前话题相关的记忆/);
  assert.match(text, /### 全局索引（INDEX.md）/);
});

/**
 * 检索式注入：消息里原样出现的写法（哪怕条目没有日期）必须进提示词。
 *
 * 这是设计 §1.2 的真实事故回归：那条老梗在 COGNITION.md 里写得完整，但没有「首见日期」，
 * 旧实现把它当最旧，于是永远进不了热梗段。现在它由「消息里出现 → 命中」捞出来，
 * 不看日期、也不看它在文件里排第几。
 */
test('a no-date cognition row is recalled when the incoming message uses it', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const memoryDir = join(cwd, '.qq-memory');
  await mkdir(memoryDir, { recursive: true });
  const dated = Array.from({ length: 20 }, (_, index) => `- 新梗${index}｜刚学的｜2026-10-${String((index % 9) + 10).padStart(2, '0')}`).join('\n');
  await writeFile(
    join(memoryDir, 'COGNITION.md'),
    `# 公共认知\n\n## 黑话与缩写\n${dated}\n- 老说法｜很久以前学的，从来没写日期\n`,
    'utf8',
  );
  onebot.push(privateMessage('你懂那个老说法是什么意思吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  const text = await until(() => {
    const current = turnContextText(agent);
    return current.includes('老说法 —— 很久以前学的') ? current : undefined;
  }, 'the no-date cognition row to reach the prompt');
  assert.match(text, /老说法 —— 很久以前学的/);
  assert.match(text, /词汇表（全部梗的写法/);
});

/** 群隔离：另一个群的 MEMORY.md 不会出现在这个群的提示词里（连候选都不是）。 */
test('another group\'s MEMORY.md never leaks into this group\'s prompt', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const memoryDir = join(cwd, '.qq-memory');
  await mkdir(join(memoryDir, 'conversations', 'group-200000001'), { recursive: true });
  await writeFile(
    join(memoryDir, 'conversations', 'group-200000001', 'MEMORY.md'),
    '# 另一个群\n\n## 事实与事件\n- 另一个群的暗号｜只有那个群知道\n',
    'utf8',
  );
  onebot.push(mention('另一个群的暗号是什么'));
  await until(() => host.list.created[0], 'the group Agent');
  const text = promptText(host, 'qq-bridge:channel');
  assert.doesNotMatch(text, /另一个群的暗号/);
});

/** 私聊写入闸门：私聊会话对全局 COGNITION.md / PEOPLE.md 的写请求一律拒绝。 */
test('a private chat cannot write the global COGNITION.md or PEOPLE.md', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const tool = host.tools.get('qq_memory');
  onebot.push(privateMessage('私聊里聊点事'));
  const privateId = sessionIdFor('private:100000002');
  const privateAgent = await until(() => host.list.created.find((agent) => agent.id === privateId), 'the private Agent');
  await assert.rejects(
    () => tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '私聊梗', meaning: '私聊里学的说法' }, { agent: privateAgent }),
    /private chat must not write/,
  );
  await assert.rejects(
    () => tool.execute({ action: 'append', path: 'PEOPLE.md', text: '- 某人｜私聊里知道的人' }, { agent: privateAgent }),
    /private chat must not write/,
  );
  assert.equal(existsSync(join(cwd, '.qq-memory', 'COGNITION.md')), false, '被拒绝的写入不能留下文件');
  assert.equal(existsSync(join(cwd, '.qq-memory', 'PEOPLE.md')), false);

  // 同一段私聊写自己的 MEMORY.md 是允许的 —— 闸门只挡「升级到全局」。
  const own = await tool.execute(
    { action: 'upsert', path: 'conversations/private-100000002/MEMORY.md', name: '私聊事实', meaning: '只有这段私聊知道', section: '事实与事件' },
    { agent: privateAgent },
  );
  assert.equal(own.action, 'upsert');
  assert.match(await readMemory(cwd, 'conversations/private-100000002/MEMORY.md'), /私聊事实｜只有这段私聊知道/);

  // 对照：群会话写同一个全局文件是允许的（闸门不是一刀切）。
  onebot.push(mention('群里也说一个梗'));
  const groupId = sessionIdFor('group:100000001');
  const groupAgent = await until(() => host.list.created.find((agent) => agent.id === groupId), 'the group Agent');
  await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '公共梗', meaning: '群里公开说的' }, { agent: groupAgent });
  assert.match(await readMemory(cwd, 'COGNITION.md'), /公共梗｜群里公开说的/);
  // 人物表与热层记忆也支持逐条 upsert（新的结构化路径）。
  const person = await tool.execute(
    { action: 'upsert', path: 'PEOPLE.md', name: 'kaguya', qq: '100000001', aliases: 'soyo', meaning: '群主，周六常组织打本' },
    { agent: groupAgent },
  );
  assert.equal(person.note, 'added in «人物»');
  assert.match(await readMemory(cwd, 'PEOPLE.md'), /kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本/);
  const fact = await tool.execute(
    { action: 'upsert', path: 'conversations/group-100000001/MEMORY.md', name: '周五固定开黑', meaning: '晚上八点', section: '惯例与偏好', date: '2026-10-18' },
    { agent: groupAgent },
  );
  assert.equal(fact.action, 'upsert');
  assert.match(await readMemory(cwd, 'conversations/group-100000001/MEMORY.md'), /## 惯例与偏好\n- 周五固定开黑｜晚上八点｜首见 2026-10-18/);
});

/**
 * 私聊摘要不升级：摘要 Agent 在私聊那一轮里对全局文件的写同样被拒绝，
 * 新事实只能落进那个私聊的 MEMORY.md。
 *
 * 摘要 Agent 不是任何 QQ 会话的 Agent（不在 sessionIndex 里），所以这条用例同时钉住
 * 「`digestTarget` 把被摘要的会话传进写入闸门」这条实现细节。
 */
test('a private digest cannot promote facts into COGNITION.md or PEOPLE.md', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  const digestId = sessionIdFor('bridge:digest');
  const errors = [];
  host.list.onFollowup = async (agent) => {
    if (agent.id !== digestId) return;
    const tool = host.tools.get('qq_memory');
    for (const path of ['COGNITION.md', 'PEOPLE.md']) {
      try {
        await tool.execute({ action: 'upsert', path, name: '私聊里学的', meaning: '只在这段私聊成立', qq: '123456' }, { agent });
      } catch (error) {
        errors.push(String(error?.message ?? error));
      }
    }
    await tool.execute(
      { action: 'upsert', path: 'conversations/private-100000002/MEMORY.md', name: '私聊事实', meaning: '只留在这段私聊', section: '事实与事件' },
      { agent },
    );
  };
  onebot.push(privateMessage('私聊里说了个只有我俩知道的事'));
  await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(errors.length, 2, `两个全局写入都该被拒绝，实际：${errors.join(' | ')}`);
  assert.ok(errors.every((message) => /private chat must not write/.test(message)), errors.join(' | '));
  assert.equal(existsSync(join(cwd, '.qq-memory', 'COGNITION.md')), false, '私聊摘要不能创建 COGNITION.md');
  assert.equal(existsSync(join(cwd, '.qq-memory', 'PEOPLE.md')), false, '私聊摘要不能创建 PEOPLE.md');
  assert.match(await readMemory(cwd, 'conversations/private-100000002/MEMORY.md'), /私聊事实｜只留在这段私聊/);
});

/**
 * 滚档：热层超过阈值时，最不活跃的条目先进 archive/、再从热层删掉；search 仍然搜得到。
 */
test('memory rollover archives the least active rows instead of deleting them', async () => {
  const { onebot, host, cwd } = await bootMemory({ memoryFileMaxBytes: 4096, memoryArchiveRatio: 0.5, digestCatchUp: false });
  const tool = host.tools.get('qq_memory');
  onebot.push(privateMessage('你好'));
  const privateId = sessionIdFor('private:100000002');
  const agent = await until(() => host.list.created.find((item) => item.id === privateId), 'the private Agent');
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(`- 事实${index}｜一句话事实一句话事实｜首见 2026-10-0${(index % 9) + 1}`);
  }
  const markdown = `# 记忆\n\n## 事实与事件\n${rows.join('\n')}\n`;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  assert.ok(bytes > 2048 && bytes < 4096, `测试数据要落在阈值与上限之间，实际 ${bytes}`);
  await tool.execute({ action: 'write', path: 'conversations/private-100000002/MEMORY.md', text: markdown }, { agent });

  const archiveDir = join(cwd, '.qq-memory', 'conversations', 'private-100000002', 'archive');
  const archived = await until(async () => {
    if (!existsSync(archiveDir)) return undefined;
    const files = (await readdir(archiveDir)).filter((name) => name.endsWith('.md'));
    if (files.length === 0) return undefined;
    return { files, text: await readFile(join(archiveDir, files[0]), 'utf8') };
  }, 'the archive file to appear');

  const hot = await readMemory(cwd, 'conversations/private-100000002/MEMORY.md');
  assert.ok(Buffer.byteLength(hot, 'utf8') <= 2048, `热层要滚回阈值以下，实际 ${Buffer.byteLength(hot, 'utf8')}`);
  assert.doesNotMatch(hot, /见 archive|更早的/, '热层里不许写指针行');
  const hotRows = hot.split('\n').filter((line) => /^- /.test(line.trim())).length;
  const archivedRows = archived.text.split('\n').filter((line) => /^- /.test(line.trim())).length;
  assert.equal(hotRows + archivedRows, 40, '滚档只搬不删：条目总数守恒');

  // 冷层仍然搜得到（qq_memory search 覆盖 archive/）。
  const found = await tool.execute({ action: 'search', path: 'conversations/private-100000002/MEMORY.md', query: '事实0' }, { agent });
  assert.ok(found.returned > 0, '归档的条目必须仍然能搜到');
  assert.match(found.text, /archive\//);
  const listed = await tool.execute({ action: 'list' }, {});
  assert.ok(listed.files.some((file) => file.includes('/archive/')), `list 要能列出冷层，实际：${listed.files.join(' | ')}`);
});

/**
 * 归档写失败 → 热层原样不动：宁可暂时超一点，也不丢条目。
 *
 * 这里把 `archive/` 这个路径先占成**普通文件**，`mkdir` 就会失败 —— 用来复现磁盘权限 /
 * 路径被占住那一类真实故障。断言的是「热层一条不少」，不是「有没有报错」。
 */
test('a failed archive write leaves the hot layer untouched', async () => {
  const { onebot, host, cwd } = await bootMemory({ memoryFileMaxBytes: 4096, memoryArchiveRatio: 0.5 });
  onebot.push(privateMessage('你好'));
  const privateId = sessionIdFor('private:100000002');
  const agent = await until(() => host.list.created.find((item) => item.id === privateId), 'the private Agent');
  const convDir = join(cwd, '.qq-memory', 'conversations', 'private-100000002');
  await mkdir(convDir, { recursive: true });
  // 占住 archive/ 这个路径：rollover 的 mkdir 会失败。
  await writeFile(join(convDir, 'archive'), 'blocked', 'utf8');
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(`- 事实${index}｜一句话事实一句话事实｜首见 2026-10-0${(index % 9) + 1}`);
  }
  const markdown = `# 记忆\n\n## 事实与事件\n${rows.join('\n')}\n`;
  assert.ok(Buffer.byteLength(markdown, 'utf8') > 2048);
  const tool = host.tools.get('qq_memory');
  await tool.execute({ action: 'write', path: 'conversations/private-100000002/MEMORY.md', text: markdown }, { agent });
  await until(
    () => host.list.warnings.some((warning) => warning.includes('could not write archive/')),
    'the rollover failure to be reported',
  );
  const hot = await readMemory(cwd, 'conversations/private-100000002/MEMORY.md');
  assert.equal(hot.split('\n').filter((line) => /^- /.test(line.trim())).length, 40, '归档失败时热层一条都不能少');
  assert.equal(await readFile(join(convDir, 'archive'), 'utf8'), 'blocked', '占位文件本身不该被改');
});

/** PEOPLE.md 首次为空时从各群 MEMORY.md 的「## 人」小节抽取（一次性、幂等、只补不覆盖）。 */
test('PEOPLE.md is seeded once from conversation MEMORY.md person sections', async () => {
  const { cwd } = await bootMemory({}, {}, {}, async (root) => {
    const dir = join(root, '.qq-memory', 'conversations', 'group-100000001');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'MEMORY.md'),
      '# 群记忆\n\n## 人\n- kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本｜首见 2026-10-12\n- iroha｜爱看展的群友\n',
      'utf8',
    );
  });
  const people = await until(async () => {
    try {
      return await readMemory(cwd, 'PEOPLE.md');
    } catch {
      return undefined;
    }
  }, 'PEOPLE.md to be seeded at startup');
  assert.match(people, /kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本/);
  assert.match(people, /iroha｜爱看展的群友/);
  assert.equal(people.split('\n').filter((line) => line.startsWith('- kaguya')).length, 1, '迁移必须幂等：一人一行');
});

/** memoryDir 配到 cwd 外面时整个功能停用（与 mediaDir / stickerDir 一致）。 */
test('memory is disabled when memoryDir leaves cwd', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'qq-bridge-outside-'));
  // 这条用例断言的是「一个周期定时器都不该挂」：API key 轮换的定时器与记忆无关
  // （它默认开着），显式关掉才数得清记忆这一侧。
  const { onebot, host } = await bootMemory({ memoryDir: join(outside, 'memory'), apiKeyRotate: false });
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
      // 重置权限默认全关（见 Config.resetUsers），这组用例里有 /reset 的场景。
      resetUsers: [String(PRIVATE_USER_ID), String(GROUP_USER_ID)],
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

/** 另一个群友在群里说一句（没 @ 机器人）—— 「群里还有人说话」的信号。 */
async function groupChatter(onebot, text = '今晚吃啥', { messageId = 7001 } = {}) {
  onebot.push(groupText(text, { messageId, userId: 10001, card: 'soyo' }));
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

  // 另一个群友说了一句之后才轮到它：这一轮是插件伪造的 user message，不是谁在跟它说话。
  await groupChatter(onebot);
  host.list.timers.fireInterval();
  await until(() => agent.inbox.length >= 2, 'a proactive turn to be submitted');
  const nudge = agent.inbox[agent.inbox.length - 1].content[0].text;
  assert.match(nudge, /不是谁发给你的消息/);
  assert.match(nudge, /SKIP/);
  assert.match(nudge, /已经安静了大约 \d+ 分钟/);
  // 群里刚说过的话在这一轮的情境里 —— 有上下文才可能接得上话。
  assert.match(turnContextText(agent), /今晚吃啥/);

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

/**
 * `SKIP` 是**整个会话**的「不说了」信号，不只管主动搭话那一轮。
 *
 * 提醒落在同一个会话的上下文里，模型会在**回别人**的那一轮照样写一个 `SKIP`（真实事故：
 * 它引用了别人的表情包，正文写着 `SKIP`，群里就收到两个字面的字母）。所以「引用 + SKIP」
 * 必须一起被拦住 —— 而会「引用」的本来就只有回别人那一轮：主动搭话的 `quote` 永远是空的。
 *
 * 群聊那一条用 `replyStyle: 'quote'` 把引用**钉死在第一条**上（默认 `auto` 要等话头被挤远
 * 才引用），于是这一段正好覆盖「引用段与 SKIP 正文同时存在」的那种消息。
 */
test('a plain reply of SKIP is dropped in a quoted turn too', async () => {
  // 刻意**不**开 proactive：这是「回别人」的那条路（`owner.proactive` 没有这个标记），
  // 也正是唯一会带上引用的那条路（主动搭话的 `quote` 永远是空的）。
  const { onebot, host } = await boot(
    { proactive: false, digestCatchUp: false, digestMinLines: 9999 },
    {},
    {
      getMsg: async () => ({ sender: { nickname: 'iroha' }, message: [{ type: 'text', data: { text: '刚才那句是什么' } }] }),
    },
  );
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the first message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the first reply');

  // 引用着上一条、正文只有一个 `SKIP`：模型大概是在学着提醒里的出口，但这一轮并没有
  // 提醒，它只是「在回别人的话」。这句照样不该变成一个群友会看到的词。
  onebot.push(privateMessageWithReply('skip', '9001'));
  await until(() => agent.inbox.length >= 2, 'the quoted turn to be submitted');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  assert.equal(sentTexts(onebot, 'send_private_msg').length, 1, 'a quoted SKIP must not be sent either');
});

test('a SKIP is dropped when the reply would have carried a quote segment', async () => {
  // `replyStyle: 'quote'` 把引用**钉死在第一条**上（默认 `auto` 要等话头被挤远才引用），
  // 于是这里正好是「引用段与 SKIP 正文同时存在」的那种消息。
  const { onebot, host } = await bootProactive(
    {
      replyStyle: 'quote',
      // 这组用例只关心引用；主动说话那条路（平时 `proactiveIdleMs: 0` 一定会开口）在这里
      // 要拦住，否则两次 sweep 各自开口一次，第二轮就不是我们喂进去的那条了。
      proactiveIdleMs: 24 * 60 * 60 * 1000,
    },
    {},
    { getMsg: async () => ({ sender: { card: 'kaguya' }, message: [{ type: 'text', data: { text: '你看这个' } }] }) },
  );
  const agent = await groupWhereBotSpoke(onebot, host);

  // 「@ 了它 + 引用了上一条」：@ 是触发方式，引用才是这条用例要的输入。
  onebot.push(
    groupMessage(
      [
        { type: 'reply', data: { id: '7000' } },
        { type: 'at', data: { qq: SELF_ID, name: '小助手' } },
        { type: 'text', data: { text: '这个表情是啥' } },
      ],
      { messageId: 7002 },
    ),
  );
  await until(() => agent.inbox.length >= 2, 'the second turn to be submitted');
  completeTurn(host, agent, 'SKIP', 2);
  await settle(150);
  // 只有第一条回复（带引用的那个）：判成 SKIP 的那一条连引用段都不该发出去。
  assert.equal(sentTexts(onebot).length, 1, 'a quoted SKIP must not be sent');
  assert.deepEqual(sentTexts(onebot)[0][0], { type: 'reply', data: { id: '7000' } });
});

/** 主动说话默认关闭：连定时器都不挂，更不会开口。 */
test('proactive is on by default: the timer is registered, and proactive: false silences it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-proactive-off-'));
  // ① 默认（开着）：除了开关，其它条件调成「一定会说」—— 它就该开口。
  const on = await boot({
    cwd,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
    // 这里要数清楚「挂着几个周期定时器」：API key 轮换默认开着、与主动说话无关。
    apiKeyRotate: false,
  });
  try {
    const agent = await groupWhereBotSpoke(on.onebot, on.host);
    await groupChatter(on.onebot);
    // 摘要 + 主动说话两个定时器都挂着。
    assert.equal(on.host.list.timers.live('intervals').length, 2, 'digest and proactive timers');
    on.host.list.timers.fireInterval();
    await until(() => agent.inbox.length >= 2, 'a proactive turn by default');
  } finally {
    await on.onebot.close();
  }

  // ② 关掉之后：只剩摘要定时器，而且永远不主动开口。
  const off = await boot({
    cwd,
    proactive: false,
    proactiveChance: 1,
    proactiveIdleMs: 0,
    proactiveFromHour: 0,
    proactiveToHour: 0,
    digestCatchUp: false,
    digestMinLines: 9999,
    apiKeyRotate: false,
  });
  try {
    const agent = await groupWhereBotSpoke(off.onebot, off.host);
    await groupChatter(off.onebot);
    assert.equal(off.host.list.timers.live('intervals').length, 1, 'only the daily digest timer should be registered');
    off.host.list.timers.fireInterval();
    await settle(150);
    assert.equal(agent.inbox.length, 1, 'without proactive the bot never speaks first');
    assert.equal(sentTexts(off.onebot).length, 1);
  } finally {
    await off.onebot.close();
  }
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

  // 新开一轮会话：确认消息也是一句「机器人说的话」，于是还得等群里有人接一句才轮到它。
  // 群聊的 /reset 得 @ 它（默认 groupTrigger: mention），所以这里用 mention。
  onebot.push(mention('/reset'));
  await until(() => sentTexts(onebot).some((text) => String(text).includes('已开始新会话')), 'the reset confirmation');
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
      // 同上：默认谁都不能 /reset，这里按用例需要显式放开。
      resetUsers: [String(PRIVATE_USER_ID), String(GROUP_USER_ID)],
      activeChimeIdleMs: 0,
      delayJitter: 0,
      // 冷场主动开口那一套在这里没有意义（用例不会去 fireInterval），但把概率钉成 1
      // 可以让「补一句」这条路的随机性不影响断言。
      proactiveChance: 1,
      // 免 @ 搭话的抽卡也钉成必中：这一组用例验的是窗口 / 门槛 / 记账本身，
      // 概率曲线由 speaking-rules.test.mjs 与下面几条专门验。
      activeTalkChance: 1,
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

/** 活跃对话窗口里的空消息不算「接话」：那只是「他说了句话，正好没内容」，不能抢答。 */
test('a blank message inside the active window does not count as a follow-up', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着发一个空格：窗口虽然热，但这句没有点它，不算接话。
  onebot.push(groupText('   ', { messageId: 7001 }));
  await settle(120);
  assert.equal(agent.inbox.length, 1, '空白的「接话」不该被当成在跟它说话');
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
  onebot.push(groupText('我先走了', { messageId: 7002, userId: 10001, card: 'soyo' }));
  await settle(60);
  assert.equal(agent.inbox.length, 2, 'a different person is not part of the exchange');
});

/** A：默认关闭 —— 它放松的是「群里只在被 @ 时才说话」这条默认约定。 */
test('activeFollow is on by default, and turning it off restores the @ requirement', async () => {
  // ① 默认（开着）：被叫到之后的窗口里，同一个人接着说的话不必再 @（抽卡概率调成 1）。
  const on = await mkdtemp(join(tmpdir(), 'qq-bridge-active-on-'));
  const followed = await boot({ cwd: on, digestCatchUp: false, digestMinLines: 9999, activeTalkChance: 1 });
  try {
    followed.onebot.push(mention('在吗'));
    const agent = await until(() => followed.host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
    completeTurn(followed.host, agent, '在的', 1);
    await until(() => sentTexts(followed.onebot).length === 1, 'the reply to go out');
    followed.onebot.push(groupText('那你说呢', { messageId: 7001 }));
    await until(() => agent.inbox.length >= 2, 'the follow-up to be accepted by default');
  } finally {
    await followed.onebot.close();
  }

  // ② 关掉之后：群里仍然只在被 @ 时说话。
  const off = await mkdtemp(join(tmpdir(), 'qq-bridge-active-off-'));
  const { onebot, host } = await boot({ cwd: off, digestCatchUp: false, digestMinLines: 9999, activeFollow: false });
  try {
    onebot.push(mention('在吗'));
    const agent = await until(() => host.list.created[0], 'the group Agent to be created');
    await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
    completeTurn(host, agent, '在的', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupText('那你说呢', { messageId: 7001 }));
    await settle(80);
    assert.equal(agent.inbox.length, 1, 'without activeFollow the @ requirement still holds');
  } finally {
    await onebot.close();
  }
});

/** A：中间有别人说话，这次「你跟我聊」就算断了。 */
test('activeFollow: a third party speaking in between ends the exchange', async () => {
  const { onebot, host } = await bootActive();
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('你们聊', { messageId: 7001, userId: 10001, card: 'soyo' }));
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

/** A：两条消息之间隔太久，这段一对一的「还聊着」就断了，得重新 @ 它。 */
test('activeFollow: the one-to-one window expires when the person goes quiet', async () => {
  // 断聊间隔 1 毫秒：下一条消息到的时候必然已经过期 —— 不依赖用例跑多久。
  const { onebot, host } = await bootActive({ activeFollowIdleMs: 1 });
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

  // 另一个群友（soyo）也 @ 它：窗口换到 soyo 身上。
  onebot.push(mention('我也问一句', { userId: 10001, card: 'soyo', messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the second mention');
  completeTurn(host, agent, '你说', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  onebot.push(groupText('那然后呢', { messageId: 7002, userId: 10001, card: 'soyo' }));
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
  // 私聊走 L2（`privateAfterthought*`），不再借群聊那套 activeChime 参数。
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
  });
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
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
  });
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

/** B：群聊的补一句仍然需要 `proactive` 这个总开关（它是「允许主动发消息」的开关）。 */
test('activeChime in a group needs the proactive master switch', async () => {
  const { onebot, host } = await bootActive({ activeChimeIdleMs: 30 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await settle(200);
  assert.equal(agent.inbox.length, 1, 'without proactive a group is not chimed into');
});

/** L2：私聊补一句**不**搭 `proactive` 那趟车 —— 它默认就是开的（§6.5 的语义例外）。 */
test('the private afterthought is on by default and does not need proactive', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 30, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // proactive 关着（bootActive 默认不打开），私聊照样会补一句。
  await until(() => agent.inbox.length >= 2, 'the private follow-up turn');
  assert.match(agent.inbox[1].content[0].text, /你已经回过话/);
  assert.match(agent.inbox[1].content[0].text, /SKIP/);
  completeTurn(host, agent, '对了，你昨天说的那个事后来怎么样了', 2);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 2, 'the follow-up to go out');
});

/** L2：空消息（只是一个空格 / 单纯 @）之后的轮次不补 —— 那一轮本来就没有话题。 */
test('a reply to an empty private message does not schedule an afterthought', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 20, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('   '));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the empty message');
  completeTurn(host, agent, '？', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'an empty message is not a topic to add to');
});

/** L2：出错的那一轮不补一句（没人问过它，也别在事后追一句）。 */
test('an errored private turn does not schedule an afterthought', async () => {
  const { onebot, host } = await bootActive({ privateAfterthoughtIdleMs: 20, privateAfterthoughtChance: 1 });
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1, 'the private Agent');
  host.list.emit('agent/inbox/claimed', { agent, message: agent.inbox[0], turn: 1 });
  host.list.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } });
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the error notice');
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'no afterthought after an error');
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
  onebot.push(groupText('那我先撤了', { messageId: 7001, userId: 10001, card: 'soyo' }));
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
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 60,
    privateAfterthoughtChance: 1,
  });
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
    privateAfterthoughtIdleMs: 30,
    privateAfterthoughtChance: 1,
    privateAfterthoughtDailyMax: 1,
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

/** `/reset` 会把「还聊着」也忘掉：新开一轮之后不会再补一句。 */
test('/reset forgets the active exchange as well', async () => {
  const { onebot, host } = await bootActive({
    proactive: true,
    privateAfterthoughtIdleMs: 40,
    privateAfterthoughtChance: 1,
  });
  onebot.push(privateMessage('在吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  await until(() => agent.inbox.length >= 1, 'the message');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot, 'send_private_msg').length === 1, 'the reply');

  // 补一句还没醒就 /reset：窗口与定时器一起没了。
  onebot.push(privateMessage('/reset'));
  await until(() => sentTexts(onebot, 'send_private_msg').some((text) => String(text).includes('已开始新会话')), 'the reset confirmation');
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
  assert.ok(!sentTexts(onebot).some((text) => String(text).includes('已开始新会话')), 'the window must not run commands');
});

// ---- 多人搭话：群里几个人自己聊热了，它插进去接着聊 ---------------------------------------

/** 多人搭话的默认值：1 分钟窗口、6 条、2 个人、倾听时间 ×2。 */
test('group talk defaults: a 1-minute window, 6 lines from 2 speakers, listening doubled', () => {
  assert.equal(liveConfig(Config({})).activeWindowMs, 60 * 1000);
  assert.equal(liveConfig(Config({})).activeGroupLines, 6);
  assert.equal(liveConfig(Config({})).activeGroupSpeakers, 2);
  assert.equal(liveConfig(Config({})).activeGroupBatchScale, 2);
});

/**
 * 一对一的免 @ 接话用**自己**的断聊间隔（`activeFollowIdleMs`，默认 3 分钟），不是
 * `activeWindowMs` 那 1 分钟 —— 后者现在只管「补一句」与多人搭话的热度。两个窗口分开是
 * 刻意的：把 60 秒拉长到 3 分钟会让群更容易被判成聊热（更多插话），而一对一需要的只是
 * 「两条消息之间别太远」。
 */
test('the one-to-one window is activeFollowIdleMs, not the chime/heat window', async () => {
  // 默认 3 分钟：@ 一次买的是这一段，不是「这一整天它都归你了」。
  assert.equal(liveConfig(Config({})).activeFollowIdleMs, 3 * 60 * 1000);
  assert.equal(liveConfig(Config({})).activeWindowMs, 60 * 1000);

  // 把断聊间隔压到 1 毫秒：下一条必然已经出窗，@ 要求就回来了。
  const { onebot, host } = await bootActive({ activeFollowIdleMs: 1 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  await settle(30);
  onebot.push(groupText('那你说呢', { messageId: 7051 }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'once the window is over the @ requirement is back');
});

/** 群里几个人聊够条数之后，谁接话都不用再 @ 它 —— 这就是多人搭话。 */
test('group talk: once a few people have been chatting, anyone can talk without a mention', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 4, activeGroupSpeakers: 2 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 别人插话：一对一窗口认的是被 @ 的那个人，所以这两句都不该进去；但它们记进了
  // 「这个群最近聊了几句、几个人」，也就是搭话状态的门槛。
  onebot.push(groupText('这个我也想知道', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('+1', { messageId: 7102, userId: 10002, card: 'rana' }));
  await settle(60);
  assert.equal(agent.inbox.length, 1, 'below the threshold a stranger is still not part of the exchange');

  // 第 4 句（@ 的那条 + 这 3 条）踩到门槛：从这一条起群聊算「热起来了」，谁接话都算。
  onebot.push(groupText('那到底行不行', { messageId: 7103, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the group talk message to reach the Agent');
  // 插话（C 路）的投递文案是**元信息 + 锚点 + SKIP 出口**（§7.2）：不写清「这句不是叫你的」，
  // 模型会按「回答 soyo」组织语言，群里看到的就是答非所问。
  const interject = agent.inbox[1].content[0].text;
  assert.match(interject, /群里在聊天，这句不是叫你的/);
  assert.match(interject, /soyo 说：那到底行不行/);
  assert.match(interject, /SKIP/);

  // 门槛过了之后，换一个人、甚至同一个人再说，都还在搭话状态里。
  onebot.push(groupText('我觉得行', { messageId: 7104, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 3, 'another speaker to be admitted as well');
});

/** 人多才算「聊起来了」：同一个人自己刷屏，条数再多也不进搭话状态。 */
test('group talk: one person talking a lot is not a conversation', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 3, activeGroupSpeakers: 3 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 同一个人连发 6 句：条数远超 3，但说过话的只有「@ 它的那位」和「这个人」两个人，
  // 不够 activeGroupSpeakers: 3。
  for (let i = 0; i < 6; i += 1) {
    onebot.push(groupText(`第 ${i} 句`, { messageId: 7200 + i, userId: 10001, card: 'soyo' }));
  }
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'a single person spamming must not open group talk');
});

/** 搭话状态里「倾听时间」变长：攒批窗口与整批上限一起放大，多听几句再合成一轮。 */
test('group talk: it listens longer before answering', async () => {
  const { onebot, host } = await bootActive({
    batchWindowMs: 80,
    batchMaxWaitMs: 200,
    activeGroupLines: 4,
    activeGroupSpeakers: 2,
    activeGroupBatchScale: 6,
  });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('这家伙谁啊', { messageId: 7301, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('不知道', { messageId: 7302, userId: 10002, card: 'rana' }));
  // 第 4 句（@ 的那条 + 这 3 条）踩到门槛：这一条起攒批窗口从 80ms 变成 80×6 = 480ms。
  onebot.push(groupText('问问他', { messageId: 7303, userId: 10001, card: 'soyo' }));
  // 200ms 早就超过不放大时的 80ms，但还不到放大后的 480ms —— 说明它还在听。
  await settle(200);
  assert.equal(agent.inbox.length, 1, 'in group talk it keeps listening instead of cutting a batch short');
  await until(() => agent.inbox.length >= 2, 'the longer batch to flush eventually');
});

/** 多人搭话也在 `activeFollow` 这道总闸门后面：默认关着，群里照旧只在被 @ 时说话。 */
test('group talk needs activeFollow: turning it off keeps the mention requirement', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-talk-default-'));
  // 多人搭话跟着 `activeFollow` 这个总闸走；默认开，所以这里显式关掉再验「不接」。
  const { onebot, host } = await boot({
    cwd,
    digestCatchUp: false,
    digestMinLines: 9999,
    activeFollow: false,
    activeGroupLines: 2,
    activeGroupSpeakers: 2,
  });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  onebot.push(groupText('甲', { messageId: 7401, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7402, userId: 10002, card: 'rana' }));
  onebot.push(groupText('丙', { messageId: 7403, userId: 10001, card: 'soyo' }));
  await settle(80);
  assert.equal(agent.inbox.length, 1, 'with activeFollow off the group talk gate stays shut');
});

/** `/reset` 也把「大家正聊着」的那个窗口忘掉：新一轮不该接着上一轮的群聊热度。 */
test('/reset forgets the group talk window as well', async () => {
  const { onebot, host } = await bootActive({ activeGroupLines: 3, activeGroupSpeakers: 2 });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the first Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply');

  // 别人插一句：此刻窗口里是「@ 的那条 + 这一条」= 2 条，还差一条到门槛。
  onebot.push(groupText('插一句', { messageId: 7501, userId: 10001, card: 'soyo' }));
  await settle(40);
  // 明确 @ 它发 /reset：这条自己会把窗口顶到 3 条，正因为如此才要看 /reset 有没有清掉它。
  onebot.push(mention('/reset', { messageId: 7502 }));
  await until(
    () => sentTexts(onebot).some((text) => String(text).includes('已开始新会话')),
    'the reset confirmation',
  );
  await until(() => host.list.disposed.length >= 1, 'the old Agent to be disposed');

  // 若窗口没被清掉，这一条就是第 4 条（够条数、够人数），会开一个新 Agent 去接；
  // 「没有第二个 Agent」就是「群聊热度确实忘了」的证据。
  onebot.push(groupText('还在吗', { messageId: 7503, userId: 10001, card: 'soyo' }));
  await settle(80);
  assert.equal(host.list.created.length, 1, 'the old heat must not carry into the new round');
});

// ---- 免 @ 搭话的抽卡：够资格之后还要掷一次累计概率（见 speaking-rules.js）----------------
//
// 上面的多人搭话 / 免 @ 接话用例把 `activeTalkChance` 钉成 1，验的是门槛与记账本身；
// 下面这几条专门验概率曲线：没抽中就不接、连丢越多越容易中、抽中与被 @ 到之后归零、
// 对话凉了不把「保底」留到下一场。

/** 搭话抽卡：0 起、每条 +1（= 连丢一条之后必中），下面几条用例都靠它做到完全确定。 */
function talkRollConfig(overrides = {}) {
  return { activeTalkChance: 0, activeTalkChanceStep: 1, activeTalkChanceMax: 1, ...overrides };
}

test('A 路不抽卡：抽卡参数全设成 0 也照回（一对一里那个人的每条都回）', async () => {
  // `activeTalkChance: 0` + step 1：如果 A 路还抽卡，第一句就必然不接。
  const { onebot, host } = await bootActive(talkRollConfig());
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the mention to reach the Agent');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

  // 同一个人接着说的三句：一句都不能少（这就是「@ 一次之后能连着聊」）。
  for (const [index, text] of ['那你说呢', '到底行不行', '还有吗'].entries()) {
    onebot.push(groupText(text, { messageId: 7601 + index }));
    await until(() => agent.inbox.length >= index + 2, `follow-up #${index + 1} to be admitted`);
    assert.equal(agent.inbox[index + 1].content[0].text, text);
    completeTurn(host, agent, `回 ${index + 1}`, index + 2);
    await until(() => sentTexts(onebot).length >= index + 2, `reply #${index + 1} to go out`);
  }
});

test('A 路：插话（多人搭话）不顺手买一段一对一 —— 被接话的人不会接着白拿免 @', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲让热度到 2（还不够），乙踩到门槛（3 条）→ 够资格但概率 0，不接。
  onebot.push(groupText('甲', { messageId: 7631, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7632, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '搭话状态里概率 0 也不接');

  // 连丢一条之后概率涨到 1：丙这一句被接住（C 路插话）。
  onebot.push(groupText('丙', { messageId: 7633, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the next group-talk message to hit the roll');
  assert.match(agent.inbox[1].content[0].text, /soyo 说：丙/);
  completeTurn(host, agent, '嗯', 2);
  await until(() => sentTexts(onebot).length === 2, 'the interjection to go out');

  // 插话不买一对一：soyo 再说话仍然要走 C 路，而概率已经归零 → 不接。
  onebot.push(groupText('丁', { messageId: 7634, userId: 10001, card: 'soyo' }));
  await settle(100);
  assert.equal(agent.inbox.length, 2, '插话之后不留下一个一对一窗口');
});

test('多人搭话：被明确 @ 到就直接回，并把连丢的累计清零', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲让热度到 2，乙踩到门槛（3 条）→ 够资格但概率 0，先连丢一条。
  onebot.push(groupText('甲', { messageId: 7621, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7622, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '先连丢一条');

  // 被 @ 到：不抽卡，直接回；累计也该清零（它刚说过话）。
  onebot.push(mention('那这个呢', { messageId: 7623 }));
  await until(() => agent.inbox.length >= 2, 'the explicit mention to be admitted');
  completeTurn(host, agent, '这个啊', 2);
  await until(() => sentTexts(onebot).length === 2, 'the second reply');

  // 群里还热着，但第三次够资格的概率必须回到起始的 0（若保底留着，这里会是 1 = 必中）。
  onebot.push(groupText('丙', { messageId: 7624, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 2, '被 @ 到之后累计清零：这一条又回到起始概率 0');
});

test('搭话抽卡：多人搭话里也不是每条都回，攒够概率才接', async () => {
  const { onebot, host } = await bootActive(talkRollConfig({ activeGroupLines: 3, activeGroupSpeakers: 2 }));
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 甲这一句让热度到 2，还差一条；乙那一句踩到门槛（3 条）—— 它就是够资格的那条，
  // 概率 0 → 不接。
  onebot.push(groupText('甲', { messageId: 7631, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7632, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '搭话状态里概率 0 也不接');

  // 连丢一条之后概率涨到 1：换一个人接话也算（C 路「谁接话都算数」）。
  onebot.push(groupText('丙', { messageId: 7633, userId: 10001, card: 'soyo' }));
  await until(() => agent.inbox.length >= 2, 'the next group-talk message to hit the roll');
  assert.match(agent.inbox[1].content[0].text, /soyo 说：丙/);
});

test('搭话抽卡：这段对话凉了之后累计清零，不把保底留到下一场聊天', async () => {
  const { onebot, host } = await bootActive(
    talkRollConfig({ activeWindowMs: 400, activeGroupLines: 3, activeGroupSpeakers: 2 }),
  );
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  // 顶到门槛（3 条）并连丢一条：甲让热度到 2，乙踩到门槛 → 够资格但概率 0，不接。
  onebot.push(groupText('甲', { messageId: 7641, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('乙', { messageId: 7642, userId: 10002, card: 'rana' }));
  await settle(100);
  assert.equal(agent.inbox.length, 1, '这一条没抽中');

  // 等热度窗口彻底凉掉（activeWindowMs = 400ms）：这段对话结束，累计也该忘掉。
  await settle(500);

  // 重新凑一场：前两条还不够热（这时「不够资格」就该把累计清掉），第三条够资格时
  // 概率必须回到起始的 0；若保底留着，这里会是 1（必中），断言就会红。
  onebot.push(groupText('丁', { messageId: 7644, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('戊', { messageId: 7645, userId: 10002, card: 'rana' }));
  onebot.push(groupText('己', { messageId: 7646, userId: 10001, card: 'soyo' }));
  await settle(150);
  assert.equal(agent.inbox.length, 1, '凉过之后回到起始概率，保底不跨对话');
});

// 用例：`.dsh/skills/` 下的每个 skill 都必须是**能被发现**的文件。
//
// frontmatter 写坏的代价是**静默消失**：dsh-skill-filesystem 只在 `ctx.logger.warn`
// 里记一句，而这个部署看不到 cordis logger，模型那边就是「这个 skill 不存在」。
// 所以把「目录名 = name、description 非空、有正文」钉成用例，顺手把 moegirl 依赖的
// 两个接口形状也钉住 —— 换成 `list=search` 那种全文搜索接口会当场失效。
test('.dsh/skills 下的每个 skill 都能被 skill-filesystem 发现', async () => {
  const root = new URL('../.dsh/skills/', import.meta.url);
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.deepEqual(
    dirs.map((entry) => entry.name).sort(),
    ['learn-meme', 'learn-sticker', 'message-digest', 'moegirl', 'update-cognition'],
    '本地 skill 的清单变了就要同步这里（docs/memory.md 的 skill 表也一样）',
  );
  for (const dir of dirs) {
    const text = await readFile(new URL(`${dir.name}/SKILL.md`, root), 'utf8');
    // 行尾刻意宽容 `\r`：Windows 上 core.autocrlf=true 的检出会把文件变成 CRLF，而
    // dsh-skill-filesystem 的真解析器本来就逐行剥 `\r`（它是宽容的）。这里若写死 `\n`，
    // 一整组用例会在 Windows 上假红 —— 「skill 明明能用，测试说它坏了」。
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert.ok(frontmatter, `${dir.name}/SKILL.md 缺 YAML frontmatter，会被整个忽略`);
    const data = yaml.load(frontmatter[1]);
    assert.equal(data.name, dir.name, 'frontmatter 的 name 必须与目录同名');
    assert.ok(
      typeof data.description === 'string' && data.description.trim().length > 0,
      `${dir.name} 的 description 不能为空（skill 目录里只列 description）`,
    );
    assert.ok(text.length > frontmatter[0].length, `${dir.name}/SKILL.md 要有正文`);
    if (dir.name === 'moegirl') {
      // 实测：匿名调 `list=search` / `rest.php/v1/search/page` 都被封，条目网页的正文是
      // 脚本渲染的；只有 opensearch（找条目名）+ prop=extracts（取正文）拿得到东西。
      assert.ok(text.includes('action=opensearch'), 'moegirl 要留着前缀搜索接口');
      assert.ok(text.includes('prop=extracts'), 'moegirl 要留着取正文的接口');
    }
  }
});

// ---- 每天轮换 API key：凭据池 → 探测 → 写回 --------------------------------------------

/**
 * 造一个假的凭据服务，形状照抄 `$DSH_HOME/.credentials.yaml` 那一层的对外 API：
 * `resolve` 读值、`set` 写值、`describe` 回答「写进去会不会被启动环境压住」。
 *
 * `calls` / `resolves` 是给用例看的账本 —— 「有没有真的写」这件事只能从这里看，
 * 因为插件从不打印 key 本身。
 */
function fakeCredentials({ value = '', writable = true, source = 'file' } = {}) {
  const calls = [];
  const resolves = [];
  const store = { value, writable, source };
  return {
    calls,
    resolves,
    store,
    async resolve() {
      resolves.push(store.value);
      return store.value.length > 0 ? { value: store.value, source: store.source } : undefined;
    },
    async describe() {
      return { configured: store.value.length > 0, source: store.source, writable: store.writable };
    },
    async set(ref, next) {
      calls.push({ ref, value: next });
      store.value = next;
      store.source = 'file';
    },
  };
}

/**
 * 起一个假的探测端点：按 `Authorization` 头认出候选 key，返回 `statusForKey` 给的状态码。
 * 真部署里这个地址是 `https://api.deepseek.com/models`（2xx = 这个 key 现在能用）。
 * @param statusForKey - key → 状态码，或 `(key) => 状态码`。
 */
async function startProbeServer(statusForKey) {
  const hits = [];
  const server = createServer((request, response) => {
    const key = String(request.headers.authorization ?? '').replace(/^Bearer\s+/u, '');
    hits.push(key);
    const status = typeof statusForKey === 'function' ? statusForKey(key) : (statusForKey[key] ?? 401);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end('{"object":"list","data":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}/models`,
    async close() {
      // fetch 的连接是 keep-alive 的：不断开的话 close() 会一直等到连接超时。
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 起一个开了 API key 轮换的实例：cwd 是新的临时目录，池子写在 `data/api-keys.txt`
 * （也就是默认位置）。
 *
 * `memory: false` 是刻意的：`fireInterval()` 会唤醒**所有**周期定时器，关掉记忆之后
 * 这一组用例里的定时器只剩轮换这一个，不必再靠 `digestMinLines` 去隔离摘要。
 */
async function bootKeyRotation({ pool, credentials, config = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-keys-'));
  if (pool !== undefined) {
    await mkdir(join(cwd, 'data'), { recursive: true });
    await writeFile(join(cwd, 'data', 'api-keys.txt'), pool, 'utf8');
  }
  return boot({ cwd, memory: false, apiKeyRotate: true, ...config }, { credentials });
}

/** 池子文件的纯函数边界：注释、空行、CRLF、前后空白、重复。 */
test('parseApiKeyPool keeps order, drops comments/blanks and de-duplicates', () => {
  assert.deepEqual(parseApiKeyPool('# 我的几个 key\n\n  sk-a  \nsk-b\r\nsk-a\n# 尾注\n'), ['sk-a', 'sk-b']);
  assert.deepEqual(parseApiKeyPool(''), []);
  assert.deepEqual(parseApiKeyPool(undefined), []);
  assert.deepEqual(parseApiKeyPool('# 一个 key 都没填\n'), []);
});

/** 轮换的主路径：从当前 key 的下一个开始试，跳过探测失败的，写第一个能用的。 */
test('api key rotation switches to the next key that passes the probe', async () => {
  const keys = {
    a: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    b: 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    c: 'sk-cccccccccccccccccccccccccccccccc',
  };
  const probe = await startProbeServer((key) => (key === keys.c ? 200 : 401));
  const credentials = fakeCredentials({ value: keys.a });
  const { host } = await bootKeyRotation({
    pool: `# 池子\n${keys.a}\n${keys.b}\n${keys.c}\n`,
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(() => credentials.calls.length > 0, 'the rotation to store the next key');
    assert.equal(credentials.store.value, keys.c, 'a 是当前值、b 探测 401，应当换成 c');
    assert.equal(credentials.calls[0].ref, 'DEEPSEEK_API_KEY');
    assert.deepEqual(probe.hits, [keys.b, keys.c], '只探测候选，且按池子顺序（当前值不用探）');
    assert.ok(
      host.list.infos.some((line) => line.includes('switched DEEPSEEK_API_KEY')),
      `expected an info line about the switch, got: ${host.list.infos.join(' | ')}`,
    );
    // 打码是硬要求：日志会进 journal、也会被贴到别处。
    const logs = [...host.list.infos, ...host.list.warnings];
    for (const key of Object.values(keys)) {
      assert.ok(!logs.some((line) => line.includes(key)), `日志里出现了完整的 key：${key}`);
    }
  } finally {
    await probe.close();
  }
});

/** 池子里没有一个能用的 key 时，宁可什么都不做也不能把 bot 换成不可用的状态。 */
test('api key rotation keeps the current key when every candidate fails the probe', async () => {
  const current = 'sk-11111111111111111111111111111111';
  const probe = await startProbeServer(() => 401);
  const credentials = fakeCredentials({ value: current });
  const { host } = await bootKeyRotation({
    pool: 'sk-22222222222222222222222222222222\nsk-33333333333333333333333333333333\n',
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(() => host.list.warnings.some((line) => line.includes('passed the probe')), 'the rotation to give up');
    assert.equal(credentials.calls.length, 0, '一个都不通过就不该写');
    assert.equal(credentials.store.value, current);
  } finally {
    await probe.close();
  }
});

/** key 由启动环境提供时写文件也是白写（环境变量优先级更高）—— 提前说清楚，别假装成功。 */
test('api key rotation stands down when the key comes from the launching environment', async () => {
  const credentials = fakeCredentials({ value: 'sk-fromenv', writable: false, source: 'env' });
  const probe = await startProbeServer(() => 200);
  const { host } = await bootKeyRotation({
    pool: 'sk-44444444444444444444444444444444\nsk-55555555555555555555555555555555\n',
    credentials,
    config: { apiKeyProbeUrl: probe.url, apiKeyProbeTimeoutMs: 3000 },
  });
  try {
    host.list.timers.fireInterval();
    await until(
      () => host.list.warnings.some((line) => line.includes('read-only by the launching environment')),
      'the rotation to report the read-only credential',
    );
    assert.equal(credentials.calls.length, 0);
    assert.deepEqual(probe.hits, [], '只读凭据下连探测都不该发生');
  } finally {
    await probe.close();
  }
});

/** 组合里没有凭据服务时只记一条 warn：轮换是顺带的事，不该把插件拖垮。 */
test('api key rotation reports a missing credentials service instead of throwing', async () => {
  const { host } = await bootKeyRotation({ pool: 'sk-a\nsk-b\n', credentials: undefined });
  host.list.timers.fireInterval();
  await until(
    () => host.list.warnings.some((line) => line.includes('credentials service is not visible')),
    'the rotation to report the missing service',
  );
});

/** 池子里没有第二个 key（或全是当前这一个）时什么都不做。 */
test('api key rotation does nothing when the pool holds no other key', async () => {
  const only = 'sk-66666666666666666666666666666666';
  const credentials = fakeCredentials({ value: only });
  const { host } = await bootKeyRotation({ pool: `${only}\n${only}\n`, credentials });
  host.list.timers.fireInterval();
  await until(() => credentials.resolves.length > 0, 'the rotation to read the current key');
  await settle(30);
  assert.equal(credentials.calls.length, 0);
  assert.equal(credentials.store.value, only);
});

/** 池子文件还没建（或还没填 key）时只记一条 info 说清楚该怎么办。 */
test('api key rotation explains a missing pool file without failing', async () => {
  const credentials = fakeCredentials({ value: 'sk-77777777777777777777777777777777' });
  const { host } = await bootKeyRotation({ pool: undefined, credentials });
  host.list.timers.fireInterval();
  await until(() => host.list.infos.some((line) => line.includes('no key pool at')), 'the rotation to explain the missing pool');
  assert.equal(credentials.calls.length, 0);
});

/** 池子配到 cwd 外就整个停用（与 mediaDir / memoryDir 同一套约定），并且不排定时器。 */
test('api key rotation is disabled when the pool file leaves cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-keys-outside-'));
  const credentials = fakeCredentials({ value: 'sk-88888888888888888888888888888888' });
  const { host } = await boot(
    // `proactive: false`：主动说话默认开着，它也会挂一个周期定时器；这条用例数的是轮换那一个。
    { cwd, memory: false, proactive: false, apiKeyRotate: true, apiKeyFile: join(cwd, '..', 'keys.txt') },
    { credentials },
  );
  assert.ok(
    host.list.warnings.some((line) => line.includes('resolves outside cwd')),
    `expected a warning, got: ${host.list.warnings.join(' | ')}`,
  );
  assert.equal(host.list.timers.live('intervals').length, 0, '停用时不该排轮换定时器');
});

/** 默认开着（池子不存在时只是不做事），显式关掉则连定时器都不挂。 */
test('api key rotation is on by default and can be switched off', async () => {
  // 不指定 cwd：boot 会给一个临时目录（写死 `/tmp` 在 Windows 上会落到 `D:\tmp`）。
  const { host } = await boot({ memory: false, proactive: false }, { credentials: fakeCredentials() });
  assert.ok(host.list.infos.some((line) => line.includes('api key rotation: on')));
  assert.equal(host.list.timers.live('intervals').length, 1, '只有一个每日轮换定时器');

  const off = await boot({ memory: false, proactive: false, apiKeyRotate: false }, { credentials: fakeCredentials() });
  assert.ok(off.host.list.infos.some((line) => line.includes('api key rotation is off')));
  assert.equal(off.host.list.timers.live('intervals').length, 0);
});

// ---- NapCat 那一侧的自检（启动时读一眼，默认只读）-------------------------------------
//
// 「它为什么不说话」里最常见的一环就在另一个软件里：插件这边全都配好了，但 NapCat
// 里没有一条启用的 WebSocket 服务器。这里验的是**接线**（index.js 有没有真的跑那次
// 自检、有没有把结论写进日志）；判据本身的边界在 test/napcat.test.mjs 里。

/** 造一个假的 NapCat 安装目录：`<root>/config/onebot11_<qq>.json`。 */
async function fakeNapcatConfig(config, qq = '10001') {
  const root = await mkdtemp(join(tmpdir(), 'qq-bridge-napcat-'));
  const dir = join(root, 'config');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `onebot11_${qq}.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { root, dir, file };
}

/** 一条「什么都没配」的 onebot11 配置。 */
const NAPCAT_EMPTY = { network: { httpServers: [], websocketServers: [], websocketClients: [] }, enableLocalFile2Url: false };

/** 自检说「NapCat 那边缺一条服务器」时要把原因和修法一起给出来，而不是只说一句「连不上」。 */
test('napcat self-check reports a missing websocket server without touching the file', async () => {
  const napcat = await fakeNapcatConfig(NAPCAT_EMPTY);
  const before = await readFile(napcat.file, 'utf8');
  const { host } = await boot({ napcatDir: napcat.root, memory: false, apiKeyRotate: false });
  await until(
    () => host.list.warnings.some((line) => line.includes('napcat:') && line.includes('没有配置任何 WebSocket 服务器')),
    'the napcat self-check to report the missing server',
  );
  assert.ok(
    host.list.warnings.some((line) => line.includes('napcat-setup.mjs')),
    `说清怎么修：${host.list.warnings.join(' | ')}`,
  );
  // 默认**不写**：那是另一个软件的配置，插件不该悄悄改它。
  assert.equal(await readFile(napcat.file, 'utf8'), before);
});

/** 打开 napcatAutoConfig 才会写：写之前留备份，写完记一句「要重启 NapCat」。 */
test('napcatAutoConfig writes the missing server with a backup and asks for a NapCat restart', async () => {
  const napcat = await fakeNapcatConfig(NAPCAT_EMPTY);
  const before = await readFile(napcat.file, 'utf8');
  const { host, onebot } = await boot({ napcatDir: napcat.root, napcatAutoConfig: true, memory: false, apiKeyRotate: false });
  await until(
    () => host.list.infos.some((line) => line.includes('napcat:') && line.includes('重启 NapCat')),
    'the napcat self-check to write the server',
  );
  const patched = JSON.parse(await readFile(napcat.file, 'utf8'));
  const server = patched.network.websocketServers[0];
  // 端口必须写的是**插件连的那个**（假 OneBot 用的是系统分配的随机端口）。
  assert.equal(server.port, Number(new URL(onebot.endpoint).port));
  assert.equal(server.enable, true);
  assert.equal(server.reportSelfMessage, false);
  const backups = (await readdir(napcat.dir)).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1, '改之前要留一份原文件');
  assert.equal(await readFile(join(napcat.dir, backups[0]), 'utf8'), before);
});

// 「已经配好了就只记一句 info、不刷 warn」这一条没有放在这里：假 OneBot 用的是系统分配的
// 随机端口，而这个用例需要**先知道端口**才能把 NapCat 的配置写成「已经对了」的样子，
// 在 boot() 之后再改配置又赶不上那次自检。它由 test/napcat.test.mjs 的
// `repairNapcat` → `action: 'ok'`（幂等、不产生第二个备份）覆盖。


// ---- 插话的准入与指向（§7.1 / §7.3 / §7.5）------------------------------------

/**
 * 起一个「群已经聊热、插话必中」的实例，并让它被 @ 过一次（这样会话记录与一对一窗口都在）。
 * @returns `{ onebot, host, agent }`：已经回完一轮的实例。
 */
async function bootHotGroup(overrides = {}) {
  const { onebot, host } = await bootActive({
    activeGroupLines: 3,
    activeGroupSpeakers: 2,
    activeTalkChance: 1,
    ...overrides,
  });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');
  return { onebot, host, agent };
}

test('插话轮不再强制引用锚点：紧挨着回时按 replyStyle: auto 走裸文本', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  // 两个不同的人把热度顶过门槛（第 4 句才够热），第三句是那条被接的锚点。
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('随便', { messageId: 7102, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 2, 'the interject turn');
  const interject = agent.inbox[1].content[0].text;
  assert.match(interject, /这句不是叫你的/);
  assert.match(interject, /rana 说：随便/);

  completeTurn(host, agent, '火锅吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the interject reply');
  // 插话不挂指向：它不是在「回某一条」，而是顺着气氛自己凑一句（见 `quoteHead` 第 0 条）。
  // 紧挨着回时本来就该是裸文本 —— 以前那条「插话必须引用锚点」的规矩连同
  // `interjectQuote` 一起删了。
  assert.equal(sent, '火锅吧');
});

test('插话轮不挂引用：replyStyle: quote 也只发裸文本', async () => {
  // `replyStyle` 是「回别人的时候怎么指向」的配置，插话不是回答，不该被它钉上一个引用块。
  const { onebot, host, agent } = await bootHotGroup({ replyStyle: 'quote' });
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  onebot.push(groupText('随便', { messageId: 7102, userId: 10002, card: 'rana' }));
  await until(() => agent.inbox.length >= 2, 'the interject turn');
  completeTurn(host, agent, '火锅吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the interject reply');
  assert.equal(sent, '火锅吧', '搭话不是「回某一条」，引用块会让人觉得是在处理工单');
});

test('免 @ 接话也不挂指向：replyStyle: at 的那一轮只发裸文本', async () => {
  // A 路（窗口里接上的一句）与 C 路（插话）同一口径：都是它自己凑上来的，不点名。
  const { onebot, host } = await bootActive({ replyStyle: 'at' });
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent');
  await until(() => agent.inbox.length >= 1, 'the mention');
  completeTurn(host, agent, '在的', 1);
  await until(() => sentTexts(onebot).length === 1, 'the first reply');

  onebot.push(groupText('那你说呢', { messageId: 7001 }));
  await until(() => agent.inbox.length >= 2, 'the follow-up without a mention');
  completeTurn(host, agent, '就这样吧', 2);
  const sent = await until(() => sentTexts(onebot)[1], 'the follow-up reply');
  assert.equal(sent, '就这样吧', '免 @ 接话不是回提问者，不该再 @ 一次');
});

test('插话不接 @ 了别人的消息（那是别人在跟别人说话）', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  // 这一条 @ 的是 rana，不是机器人：热度早就够了，但它不该被当成「可以插一句」。
  onebot.push(groupMessage(
    [{ type: 'at', data: { qq: '10002', name: 'rana' } }, { type: 'text', data: { text: ' 你看这个' } }],
    { messageId: 7102, userId: 10001, card: 'soyo' },
  ));
  await settle(120);
  assert.equal(agent.inbox.length, 1, 'a message meant for somebody else is not an invitation');
});

test('插话不接命令，也不接纯媒体（没有可接的话头）', async () => {
  const { onebot, host, agent } = await bootHotGroup();
  onebot.push(groupText('晚上吃啥', { messageId: 7101, userId: 10001, card: 'soyo' }));
  // 命令：即使群里正热，`/reset` 也不该被「插话」顺手执行（更不该进模型）。
  onebot.push(groupText('/reset', { messageId: 7102, userId: 10001, card: 'soyo' }));
  // 纯媒体：正文只有 `[图片]` 这个占位符，没有文字锚点。
  onebot.push(groupMessage([{ type: 'image', data: { file: 'x.png', url: '' } }], { messageId: 7103, userId: 10002, card: 'rana' }));
  await settle(150);
  assert.equal(agent.inbox.length, 1, 'a command and a media-only message are not interjected into');
});

// ---- 感知与互动：戳一戳 / 链接 / 视频封面 / 语音（§8）------------------------

/** 造一条戳一戳的通知事件（OneBot v11 的 notice/notify/poke）。 */
function pokeNotice({ userId = 100000002, targetId = SELF_ID, groupId, name = 'iroha' } = {}) {
  return {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    user_id: userId,
    target_id: targetId,
    ...(groupId === undefined ? {} : { group_id: groupId }),
    sender: { nickname: name },
  };
}

test('戳一戳：回戳那个戳它的人，冷却之内不再重复', async () => {
  const { onebot, host } = await boot({ pokeMode: 'poke', pokeCooldownMs: 60_000 });
  onebot.push(pokeNotice());
  const poke = await until(() => onebot.calls.find((call) => call.action === 'send_poke'), 'the poke back');
  // 回戳只打给戳它的人（user_id），从不打给别人。
  assert.equal(String(poke.params.user_id), '100000002');
  // 冷却期里再戳几下也只回一次 —— 防两个机器人互戳的关键一道闸。
  onebot.push(pokeNotice());
  onebot.push(pokeNotice());
  await settle(120);
  assert.equal(onebot.calls.filter((call) => call.action === 'send_poke').length, 1);
  await onebot.close();
});

test('戳一戳：只回应戳机器人的，别人互相戳不关它的事', async () => {
  const { onebot } = await boot({ pokeMode: 'poke' });
  onebot.push(pokeNotice({ userId: 10001, targetId: 10002, groupId: 100000001 }));
  await settle(120);
  assert.equal(onebot.calls.filter((call) => call.action === 'send_poke').length, 0);
  await onebot.close();
});

test('戳一戳：pokeMode text 走一轮模型，正文说清「不是正式提问」并给 SKIP 出口', async () => {
  const { onebot, host } = await boot({ pokeMode: 'text' });
  onebot.push(pokeNotice());
  const agent = await untilInbox(host, 1, 'the poke turn');
  const text = agent.inbox[0].content[0].text;
  assert.match(text, /戳了你一下/);
  assert.match(text, /SKIP/);
  // 戳一戳不是「插件自作主张」：这句话本来就是转告一个真人动作，说明来源反而更清楚。
  assert.match(text, /不是正式提问/);
  await onebot.close();
});

test('linkPreview：打开后把裸 URL 换成「标题 + 域名」，内网地址默认不抓', async () => {
  const page = await startImageServer(Buffer.from('<html><head><title>示例标题</title></head></html>'), {
    contentType: 'text/html; charset=utf-8',
  });
  try {
    const off = await boot({ linkPreview: false });
    off.onebot.push(privateMessage(`看这个 ${page.url()}/a`));
    const offAgent = await untilInbox(off.host, 1, 'the url message without preview');
    assert.match(offAgent.inbox[0].content[0].text, /https?:\/\/127\.0\.0\.1/);
    assert.equal(page.hits.length, 0, '默认关时一个请求都不该发');
    await off.onebot.close();

    const on = await boot({ linkPreview: true, linkAllowPrivateHosts: true });
    on.onebot.push(privateMessage(`看这个 ${page.url()}/b`));
    const onAgent = await untilInbox(on.host, 1, 'the url message with preview');
    assert.match(onAgent.inbox[0].content[0].text, /\[链接: 【示例标题】/);
    assert.ok(page.hits.includes('/image/b'), `server hits: ${page.hits.join(',')}`);
    await on.onebot.close();
  } finally {
    await page.close();
  }
});

test('视频只下封面：正文给出时长与封面路径，整段不下载', async () => {
  const cover = await startImageServer(TINY_PNG);
  try {
    const { onebot, host } = await boot({ videoCover: true });
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 100000002,
      sender: { nickname: 'iroha' },
      message: [{ type: 'video', data: { duration: 12, thumb: cover.url('/thumb') } }],
    });
    const agent = await untilInbox(host, 1, 'the video message');
    const text = agent.inbox[0].content[0].text;
    assert.match(text, /\[视频 12 秒 · 封面: \.qq-media\/[0-9a-f]+\.png\]/);
    assert.ok(cover.hits.includes('/thumb'));
    await onebot.close();
  } finally {
    await cover.close();
  }
});

test('语音只做时长占位：不下载文件、也不起任何进程', async () => {
  const { onebot, host } = await boot();
  onebot.push({
    post_type: 'message',
    message_type: 'private',
    user_id: 100000002,
    sender: { nickname: 'iroha' },
    message: [{ type: 'record', data: { duration: 3, file: 'abc.amr', url: 'https://example.invalid/x.amr' } }],
  });
  const agent = await untilInbox(host, 1, 'the voice message');
  assert.equal(agent.inbox[0].content[0].text, '[语音 3 秒]');
  await onebot.close();
});

// ---- 人格与表达的提示词槽位（P3）-----------------------------------------------

/** 造一份人设文件与一份表达文件（放在一个临时 cwd 的 `.qq-persona/` 下）。 */
async function bootWithPersona(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-persona-'));
  await mkdir(join(cwd, '.qq-persona'), { recursive: true });
  await writeFile(join(cwd, '.qq-persona', 'PERSONA.md'), [
    '## 身份',
    '- 名字：小栞',
    '## 性格',
    '- [x] 温柔｜底色｜0.8｜别人难受时｜先接住情绪',
    '- [x] 傲娇｜点缀｜0.5｜被夸时｜嘴硬一句就结束',
    '## 场景',
    '### 私聊',
    '- 私聊场景标记',
    '### 群聊',
    '- 群聊场景标记',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, '.qq-persona', 'STYLE.md'), [
    '## 总体',
    '- 表达文件标记：一条回复一两个气泡',
    // 故意用不认识的节名：内容必须并进「总体」照样生效（写歪了不能静默丢）。
    '## 语气',
    '- 语气节标记',
    '## 群聊',
    '- 群聊表达标记',
  ].join('\n'), 'utf8');
  const booted = await boot({ cwd, ...config }, hostOptions, onebotOptions);
  return { ...booted, cwd };
}

test('PERSONA.md 优先于配置 persona，且按场景选段', async () => {
  const group = await bootWithPersona({ persona: '配置里那段人设' });
  try {
    group.onebot.push(mention('在吗'));
    const agent = await untilInbox(group.host, 1, 'the group Agent');
    const prompt = promptText(group.host, 'qq-bridge:channel');
    const context = turnContextText(agent);
    assert.match(prompt, /【身份】名字：小栞/);
    assert.match(prompt, /【底色｜始终在场】别人难受时 → 温柔/);
    assert.match(context, /【本轮场景｜群聊】群聊场景标记/);
    assert.doesNotMatch(context, /私聊场景标记/, '群聊轮不该带私聊的场景段');
    assert.doesNotMatch(prompt, /配置里那段人设/, '文件存在时配置 persona 被忽略（不叠加）');
    assert.equal(agent.inbox.length, 1);
    // 表达契约来自 STYLE.md；不认识的节（`## 语气`）内容也要并进「总体」生效。
    assert.match(prompt, /表达文件标记/);
    assert.match(prompt, /语气节标记/);
    assert.match(prompt, /群聊表达标记/);
    // 「行，」这类应答开场在硬性规则里：STYLE.md 没写它，也删不掉它。
    const hardRulesAt = prompt.indexOf('硬性要求（最高优先级');
    assert.ok(hardRulesAt >= 0);
    assert.ok(
      prompt.indexOf('这类应答开场') > hardRulesAt,
      '应答开场禁令属于硬性规则，STYLE.md 删不掉',
    );
    // 空格断句（「才没有 是你没跟上我」）同样是排版地板：STYLE.md 删掉那一条也还留在这里。
    assert.ok(
      prompt.indexOf('不许拿空格当标点') > hardRulesAt,
      '空格不是标点的禁令属于硬性规则，STYLE.md 删不掉',
    );
  } finally {
    await group.onebot.close();
  }

  // 私聊轮选私聊那段场景。
  const priv = await bootWithPersona();
  try {
    priv.onebot.push(privateMessage('在吗'));
    await untilInbox(priv.host, 1, 'the private Agent');
    const prompt = promptText(priv.host, 'qq-bridge:channel');
    const context = turnContextText(priv.host.list.created[0]);
    assert.match(context, /【本轮场景｜私聊】私聊场景标记/);
    assert.doesNotMatch(context, /群聊场景标记/);
  } finally {
    await priv.onebot.close();
  }
});

test('提示词槽位：硬性规则在最后（最高优先级），且表达契约在记忆之前', async () => {
  const { onebot, host } = await boot();
  try {
    onebot.push(privateMessage('在吗'));
    await untilInbox(host, 1, 'the Agent');
    const prompt = promptText(host, 'qq-bridge:channel');
    const at = (needle) => {
      const index = prompt.indexOf(needle);
      assert.ok(index >= 0, `提示词里应当有「${needle}」`);
      return index;
    };
    // 顺序：场景/人设 → 表达契约 → 记忆 → 能力 → **硬性要求（最后）**。
    assert.ok(at('怎么说话（表达契约）') < at('硬性要求（最高优先级'));
    assert.ok(at('硬性要求（最高优先级') > at('需要主动给其他人或群发消息'));
    assert.ok(at('一条回复只有一个形状') > at('硬性要求（最高优先级'), '「一条回复只有一个形状」属于硬性要求那一节（在它之后）');
    // 表情包目录提示跟着 allowTools 走（默认不限制时应当出现「你自己的表情包」或空目录提示）。
    assert.ok(prompt.includes('硬性要求（最高优先级：人设、表达规则与上面任何一段冲突时，以本节为准）'));
  } finally {
    await onebot.close();
  }
});

// ---- 被撤回的消息（见 docs/recall.md）--------------------------------------------
//
// 这一组钉的是三层里**最难从代码看出来**的那部分：撤回落在「待回批次 / 在飞 / 已回复」
// 三个不同位置时行为不同，而「不引用一条已撤回的消息」是正确性问题 —— 引用失败会让
// 整条回复剩下的气泡一起发不出去（§1.4）。
//
// 与 `bootProactive` 同款：`digestMinLines` 抬到很高，免得假定时器把摘要循环顺带跑起来。

/** 起一个开了撤回处理的实例；闸门默认全部放宽，要验哪道就自己收紧。 */
async function bootRecall(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-recall-'));
  return boot(
    {
      recallMode: 'ignore',
      // `recallAddressed` / `recallPrivate` 不在这里钉：它们跟 schema 默认走（drop / true），
      // 要验另一面（answer / 私聊不处理）的用例自己显式传。
      recallScope: 'to-me',
      recallChance: 1,
      recallCooldownMs: 0,
      recallDailyMax: 0,
      recallMaxAgeMs: 0,
      recallTeaseQuote: false,
      recallMemoryMark: true,
      digestCatchUp: false,
      digestMinLines: 9999,
      ...config,
      cwd,
    },
    hostOptions,
    onebotOptions,
  );
}

/** 造一条群撤回通知（`operator_id` 只在给了的时候才出现，与真实实现一致）。 */
function groupRecall({ messageId = 7000, userId = GROUP_USER_ID, operatorId } = {}) {
  const event = {
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 100000001,
    user_id: userId,
    message_id: messageId,
  };
  if (operatorId !== undefined) event.operator_id = operatorId;
  return event;
}

/** 发出去的群消息里有没有 `reply` 段（引用一条已撤回的消息会让整条回复发不出去）。 */
function quotedAny(onebot) {
  return onebot.calls.some(
    (call) =>
      call.action === 'send_group_msg'
      && Array.isArray(call.params.message)
      && call.params.message.some((segment) => segment?.type === 'reply'),
  );
}

test('撤回：tease + 被 @ 的那条还在攒批窗口里 → 这一轮就地改写成调侃', async () => {
  // `replyStyle: quote` 把引用钉在第一条上：没有安全层的话这条回复会带着 reply 段出去。
  // 改写只在 `recallAddressed: answer` 这一档发生；默认是 `drop`（真不回），不存在改写。
  const { onebot, host } = await bootRecall({
    recallMode: 'tease',
    recallAddressed: 'answer',
    batchWindowMs: 400,
    replyStyle: 'quote',
  });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    // 紧接着撤回：这一批还没进模型（还在攒批窗口里）。
    onebot.push(groupRecall({ messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the rewritten turn to be submitted');
    assert.equal(agent.inbox.length, 1, '改写：本来就要开的这一轮，不另开一轮');
    const text = agent.inbox[0].content[0].text;
    assert.match(text, /撤回/);
    assert.match(text, /kaguya/);
    // 正文被整个换掉了：默认不给原文（recallTeaseQuote: false）。
    assert.doesNotMatch(text, /晚上吃啥/);

    completeTurn(host, agent, '撤什么呀，我看见了', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the tease to go out');
    assert.equal(sent[0], '撤什么呀，我看见了');
    assert.equal(quotedAny(onebot), false, '绝不引用一条已经不在的消息');
  } finally {
    await onebot.close();
  }
});

test('撤回：ignore + answer → 照常回答、不引用（它根本没注意到撤回）', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'ignore', recallAddressed: 'answer', batchWindowMs: 400, replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    onebot.push(groupRecall({ messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the addressed turn to be submitted');
    const text = agent.inbox[0].content[0].text;
    // 「假装没看到」最自然的形态：模型看见的还是原问题。
    assert.match(text, /晚上吃啥/);
    assert.doesNotMatch(text, /撤回/);

    completeTurn(host, agent, '吃火锅', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the reply to go out');
    assert.equal(sent[0], '吃火锅');
    assert.equal(quotedAny(onebot), false, '引用被清掉了，否则这条回复会整条发不出去');
  } finally {
    await onebot.close();
  }
});

test('撤回：ignore + recallAddressed=drop → 被 @ 的那条真不回', async () => {
  // `recallAddressed: drop` 是默认值；这里显式写着，是为了让这条用例自己说明在验哪一档。
  const { onebot, host } = await bootRecall({ recallAddressed: 'drop', batchWindowMs: 400 });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    onebot.push(groupRecall({ messageId: 7000 }));
    // 等到比整个攒批窗口还久：真有东西要投的话早就投了。
    await settle(700);
    assert.equal(host.list.created.length, 0, '撤回 = 当没收到：一个 Agent 都不该被造出来');
    assert.deepEqual(sentTexts(onebot), []);
  } finally {
    await onebot.close();
  }
});

test('撤回：tease + turn 在飞 → 只清引用，不补刀', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn to be submitted');
    // 还没 completeTurn：这一轮正在飞（`busyWithTurn` 为真）。
    onebot.push(groupRecall({ messageId: 7000 }));
    await settle(120);

    completeTurn(host, agent, '吃火锅', 1);
    const sent = await until(() => (sentTexts(onebot).length === 1 ? sentTexts(onebot) : undefined), 'the reply to go out');
    assert.equal(sent[0], '吃火锅');
    assert.equal(quotedAny(onebot), false);

    // 只有一条：这一轮的回复本身就是回应，再补一句是连发两条。
    await settle(200);
    assert.equal(agent.inbox.length, 1);
    assert.equal(sentTexts(onebot).length, 1);
  } finally {
    await onebot.close();
  }
});

test('撤回：tease + 已经回过了 → 补一句调侃，不引用、也不带原文', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', replyStyle: 'quote' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn to be submitted');
    completeTurn(host, agent, '吃火锅', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the tease turn to be submitted');
    const text = agent.inbox[1].content[0].text;
    assert.match(text, /不是谁发给你的消息/, '必须说清这不是谁在跟它说话');
    assert.match(text, /kaguya/);
    assert.match(text, /你已回过/);
    assert.match(text, /SKIP/, 'nudge 必须给出 SKIP 出口');
    assert.doesNotMatch(text, /晚上吃啥/, '默认不给原文');

    completeTurn(host, agent, '撤得有点晚，我都回了', 2);
    const sent = await until(() => (sentTexts(onebot).length === 2 ? sentTexts(onebot) : undefined), 'the tease to go out');
    assert.equal(sent[1], '撤得有点晚，我都回了');
    // 调侃那一条是**裸文本**（没有段数组）：它不指向任何消息 —— 被撤的那条早就不在了。
    assert.equal(typeof sent[1], 'string');
  } finally {
    await onebot.close();
  }
});

test('撤回：冷却之内的第二次撤回不再补一句（但第一次照样用掉机会）', async () => {
  // 两条消息几乎同时到 → 攒成一轮，于是「两条都已经回过」，冷却成为唯一挡住第二次的东西。
  const { onebot, host } = await bootRecall({ recallMode: 'tease', batchWindowMs: 400, recallCooldownMs: 60000 });
  try {
    onebot.push(mention('第一句', { messageId: 7000 }));
    onebot.push(mention('第二句', { messageId: 7001 }));
    const agent = await untilInbox(host, 1, 'the batched turn');
    assert.equal(agent.inbox.length, 1, '两条攒成一轮');
    completeTurn(host, agent, '好', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the first tease turn');
    // SKIP：一个字都不发，但这次机会照样用掉（先记账再 followup）。
    completeTurn(host, agent, 'SKIP', 2);
    await settle(150);
    assert.equal(sentTexts(onebot).length, 1);

    onebot.push(groupRecall({ messageId: 7001 }));
    await settle(200);
    assert.equal(agent.inbox.length, 2, '冷却期内不补第二句');
  } finally {
    await onebot.close();
  }
});

test('撤回：当天次数到上限就不再补一句（0 = 不限）', async () => {
  const { onebot, host } = await bootRecall({ recallMode: 'tease', batchWindowMs: 400, recallDailyMax: 1 });
  try {
    onebot.push(mention('第一句', { messageId: 7000 }));
    onebot.push(mention('第二句', { messageId: 7001 }));
    const agent = await untilInbox(host, 1, 'the batched turn');
    completeTurn(host, agent, '好', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');

    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the only tease of the day');
    completeTurn(host, agent, 'SKIP', 2);
    await settle(150);

    onebot.push(groupRecall({ messageId: 7001 }));
    await settle(200);
    assert.equal(agent.inbox.length, 2, 'recallDailyMax: 1 → 第二条不再开口');
  } finally {
    await onebot.close();
  }
});

test('撤回：管理员代撤、自己发的话被撤、太久以前的撤回都不调侃', async () => {
  // ① 管理员替别人撤了话：调侃他等于公开处刑，而且对象错了。
  const operator = await bootRecall({ recallMode: 'tease' });
  try {
    operator.onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(operator.host, 1, 'the turn');
    completeTurn(operator.host, agent, '吃火锅', 1);
    await until(() => sentTexts(operator.onebot).length === 1, 'the reply to go out');
    operator.onebot.push(groupRecall({ messageId: 7000, operatorId: 10002 }));
    await settle(200);
    assert.equal(agent.inbox.length, 1, 'operator_id ≠ user_id 时不调侃');
  } finally {
    await operator.onebot.close();
  }

  // ② 机器人自己发的话被撤：那是另一件事（多半也是管理员操作），连账都不记。
  const own = await bootRecall({ recallMode: 'tease' });
  try {
    own.onebot.push(groupText('在的', { messageId: 7005, userId: SELF_ID, name: '小助手' }));
    own.onebot.push(groupRecall({ messageId: 7005, userId: SELF_ID }));
    await settle(200);
    assert.equal(own.host.list.created.length, 0, '自己的消息不进「最近看见过」，所以没有可调侃的对象');
  } finally {
    await own.onebot.close();
  }

  // ③ 太久以前的撤回：`recallMaxAgeMs` 之内才算数。
  const stale = await bootRecall({ recallMode: 'tease', recallMaxAgeMs: 100 });
  try {
    stale.onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(stale.host, 1, 'the turn');
    completeTurn(stale.host, agent, '吃火锅', 1);
    await until(() => sentTexts(stale.onebot).length === 1, 'the reply to go out');
    await settle(250);
    stale.onebot.push(groupRecall({ messageId: 7000 }));
    await settle(200);
    assert.equal(agent.inbox.length, 1, '超时的撤回不再提');
  } finally {
    await stale.onebot.close();
  }
});

test('撤回：ignore 会把群聊环境上下文里那条也摘掉', async () => {
  const { onebot, host } = await bootRecall();
  try {
    onebot.push(groupText('别记我说过这句', { messageId: 7002, userId: 10001, card: 'soyo' }));
    onebot.push(groupText('这句留着', { messageId: 7003, userId: 10001, card: 'soyo' }));
    onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    onebot.push(mention('刚才说啥了', { messageId: 7000 }));

    const agent = await untilInbox(host, 1, 'the addressed turn');
    const prompt = turnContextText(agent);
    // 「假装没看到」必须连环境上下文也一起删：不然它下次被 @ 时又读到那句。
    assert.doesNotMatch(prompt, /别记我说过这句/);
    assert.match(prompt, /这句留着/, '没被撤回的那条照旧在上下文里');
  } finally {
    await onebot.close();
  }
});

test('撤回：tease + scope all 会为别人的撤回开口，to-me 不会', async () => {
  // ① all：群里别人的闲聊被撤回 → 主动开一轮调侃。
  const all = await bootRecall({ recallMode: 'tease', recallScope: 'all' });
  try {
    // 先让它在这个群里说过话：没有会话记录就不主动开口（与主动说话同一条纪律）。
    all.onebot.push(mention('在吗', { messageId: 7000 }));
    const agent = await untilInbox(all.host, 1, 'the first turn');
    completeTurn(all.host, agent, '在的', 1);
    await until(() => sentTexts(all.onebot).length === 1, 'the first reply');

    all.onebot.push(groupText('他们聊他们的', { messageId: 7002, userId: 10001, card: 'soyo' }));
    all.onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    await untilInbox(all.host, 2, 'the ambient tease');
    const text = agent.inbox[1].content[0].text;
    assert.match(text, /不是谁发给你的消息/);
    assert.match(text, /soyo/);
    assert.match(text, /你没回过/);
  } finally {
    await all.onebot.close();
  }

  // ② to-me：同样的序列，但它不该为别人的撤回开口。
  const toMe = await bootRecall({ recallMode: 'tease', recallScope: 'to-me' });
  try {
    toMe.onebot.push(mention('在吗', { messageId: 7000 }));
    const agent = await untilInbox(toMe.host, 1, 'the first turn');
    completeTurn(toMe.host, agent, '在的', 1);
    await until(() => sentTexts(toMe.onebot).length === 1, 'the first reply');

    toMe.onebot.push(groupText('他们聊他们的', { messageId: 7002, userId: 10001, card: 'soyo' }));
    toMe.onebot.push(groupRecall({ messageId: 7002, userId: 10001 }));
    await settle(250);
    assert.equal(agent.inbox.length, 1, 'to-me：别人的撤回不开口');
  } finally {
    await toMe.onebot.close();
  }
});

test('撤回：转录里追加一行 tombstone，原文仍在、不重复', async () => {
  const { onebot, host, cwd } = await bootRecall({ recallMode: 'tease' });
  try {
    onebot.push(mention('晚上吃啥', { messageId: 7000 }));
    const agent = await untilInbox(host, 1, 'the turn');
    completeTurn(host, agent, '吃火锅', 1);
    await until(() => sentTexts(onebot).length === 1, 'the reply to go out');
    onebot.push(groupRecall({ messageId: 7000 }));
    await untilInbox(host, 2, 'the tease turn');

    // 转录是后台串行写盘的，所以等它落地再看内容。
    const logFile = join(cwd, '.qq-memory', 'conversations', 'group-100000001', 'log', `${localDateOf()}.jsonl`);
    const lines = await until(async () => {
      if (!existsSync(logFile)) return undefined;
      const parsed = (await readFile(logFile, 'utf8')).trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
      return parsed.some((line) => line.kind === 'recall') ? parsed : undefined;
    }, 'the recall tombstone to be written');

    const tombstone = lines.find((line) => line.kind === 'recall');
    assert.equal(tombstone.recall, '7000');
    assert.equal(tombstone.user, String(GROUP_USER_ID));
    assert.equal(tombstone.addressed, true);
    // 追加而不是删行：原文还在，而且只有那一行。
    assert.equal(lines.filter((line) => line.text === '晚上吃啥').length, 1, '原文仍在、不重复');
  } finally {
    await onebot.close();
  }
});

/** 造一条私聊撤回通知（`friend_recall` 没有 group_id，也没有 operator_id）。 */
function privateRecall({ messageId = 7100, userId = PRIVATE_USER_ID } = {}) {
  return { post_type: 'notice', notice_type: 'friend_recall', user_id: userId, message_id: messageId };
}

test('撤回：私聊关掉 recallPrivate 时照常回答，默认则真不回', async () => {
  // ① 显式关掉（recallPrivate: false）：撤回被无视，那条照常投给模型 —— 这是「为什么我撤回了
  //    它还在回」的原始形态。默认值现在是「处理私聊撤回」，所以这里必须显式关。
  const defaults = await bootRecall({ batchWindowMs: 400, recallPrivate: false });
  try {
    defaults.onebot.push({ ...privateMessage('在吗'), message_id: 7100 });
    defaults.onebot.push(privateRecall({ messageId: 7100 }));
    await untilInbox(defaults.host, 1, 'the recall to be ignored in a private chat');
    assert.equal(defaults.host.list.created.length, 1, '默认不处理私聊撤回：照常回答');
  } finally {
    await defaults.onebot.close();
  }

  // ② 默认（recallPrivate: true + recallAddressed: drop）：撤回的那条从待回批次里摘掉，真的不回。
  const silent = await bootRecall({ batchWindowMs: 400 });
  try {
    silent.onebot.push({ ...privateMessage('在吗'), message_id: 7101 });
    silent.onebot.push(privateRecall({ messageId: 7101 }));
    // 等到比整个攒批窗口还久：真有东西要投的话早就投了。
    await settle(700);
    assert.equal(silent.host.list.created.length, 0, 'drop 之后一个 Agent 都不该被造出来');
    assert.deepEqual(sentTexts(silent.onebot, 'send_private_msg'), []);
  } finally {
    await silent.onebot.close();
  }
});

// ---- 定时提醒 -----------------------------------------------------------------

/**
 * 起一个群会话并把它那一轮回复跑完。
 *
 * 提醒测试需要两件事：`conversation.speakers` 已经登记（创建者是谁），以及
 * **没有在飞的 turn**（否则 agent 模式会被 `busyWithTurn` 挡回固定文案）。
 */
async function bootGroupConversation(config = {}) {
  const instance = await boot({ proactive: false, activeFollow: false, repeat: false, ...config });
  instance.onebot.push(mention('在吗'));
  const agent = await untilInbox(instance.host, 1, 'the group Agent to be created');
  completeTurn(instance.host, agent, '在');
  await until(() => sentTexts(instance.onebot, 'send_group_msg').length >= 1, 'the initial reply');
  return { ...instance, agent };
}

/**
 * 把 `Date.now` 往前拨 `ms` 再让定时器醒一次。
 *
 * 假 timer 只收集回调、不推进时钟，而提醒是「到点才发」的；这里只在这个同步窗口里
 * 拨快时钟，`fireTimeout()` 一返回就恢复 —— 异步发送链路不依赖被拨快的时间。
 */
function fireSchedulerAfter(host, ms) {
  const real = Date.now;
  try {
    Date.now = () => real() + ms;
    host.list.timers.fireTimeout();
  } finally {
    Date.now = real;
  }
}

/** 手动触发 agent 提醒的守卫（超时那条），只认 120 秒以上的 timeout。 */
function fireReminderGuard(host) {
  const guard = host.list.timers.live('timeouts').find((entry) => entry.delay >= 90_000);
  assert.ok(guard, 'the reminder guard should be armed');
  guard.callback();
}

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
