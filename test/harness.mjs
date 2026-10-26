/**
 * 集成测试的共享夹具。
 *
 * 每个用例都会起一个假的 OneBot v11 WebSocket 服务端 + 一个假的 Harness Host
 * 上下文，然后跑完整往返：入站 QQ 事件 → 投递给 Agent → 持久化 turn 事件 →
 * OneBot 发送。这里用的是真实的插件模块、真实的 OneBot 客户端、真实的
 * `createUserMessage`（消息 id 由真实实现生成），只有 Harness 服务是桩。
 *
 * 从 7,400 行的 `bridge.test.mjs` 里拆出来（每个分册一份拷贝会让 244 个用例
 * 各自维护一遍假服务端）。**只放夹具，不放用例**：用例按主题在
 * `test/bridge*.test.mjs` 里，跑 `npm test` 会全部扫到。
 *
 * 每个用例文件末尾都要 `after(cleanupBoots)`：插件持有 OneBot socket 与短定时器，
 * 不销毁的话测试进程不会退出。`cleanupBoots` 只清本进程 `liveBoots` 里的实例，
 * 所以多文件并行跑也互不干扰。
 */
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
import { SESSION_ROUTE_PATH } from '../util.js';
import { imageSegment, loadOutgoingImage } from '../image.js';
import { OTHER_PNG, PIC_JPEG, PIC_PNG } from './image-fixtures.mjs';


/** 插件默认的 `allowTools`（只读文件 + 检索 + 联网 + 七个 qq_*）：默认值的契约。 */
export const DEFAULT_ALLOW_TOOLS = [
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
export const SELF_ID = 100000000;

/** 私聊测试里的发送者（`privateMessage` 用的就是它）。 */
export const PRIVATE_USER_ID = 100000002;

/** 群聊测试里的默认发言者（`groupMessage` 用的就是它）。 */
export const GROUP_USER_ID = 100000003;


/**
 * 一个真的 1×1 PNG（67 字节，8bit RGBA）。
 * 用真图而不是随便几个字节：落盘的是不是原字节、魔数识别对不对，都要靠它来验证。
 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  'base64',
);


/** 起一个只有一个图片路由的 HTTP 服务，用来假装腾讯的图片 CDN。 */
export async function startImageServer(body = TINY_PNG, { status = 200, contentType = 'image/png' } = {}) {
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
 * @param options.getForward - `get_forward_msg` 的桩响应：`(params) => { messages: [...] }`
 *   （不传则报「不支持」，用来验证「转发取不到就保留占位符」）。
 * @param options.uploadFails - 给出时，`upload_*_file` 一律失败（用来验证「文件发不出去」的降级）。
 * @param options.groupInfoFails - 给出时，`get_group_info` 一律失败（模拟重启后 NapCat 还没就绪）。
 */
export async function startFakeOneBot({ getImage, getMsg, getForward, uploadFails, groupInfoFails } = {}) {
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
    if (frame.action === 'get_group_info') {
      if (groupInfoFails) throw new Error('get_group_info is unavailable');
      return { group_id: frame.params.group_id, group_name: '示例群' };
    }
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
    if (frame.action === 'get_forward_msg') {
      if (getForward === undefined) throw new Error('get_forward_msg is not supported by this fake');
      return await getForward(frame.params);
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
export function makeHost({
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
export function promptText(host, name) {
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
export function turnContextText(agent) {
  const message = agent?.inbox?.[agent.inbox.length - 1];
  const blocks = message?.content ?? [];
  return blocks.slice(1).map((block) => block.text ?? '').join('\n');
}


/** 轮询等待直到 `check` 返回真值；超时则测试失败。 */
export async function until(check, message, timeoutMs = 5000) {
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
export async function untilInbox(host, count = 1, message = 'the message to reach the Agent') {
  return until(() => (host.list.created[0]?.inbox.length >= count ? host.list.created[0] : undefined), message);
}


/** 造一条私聊入站事件（发送者固定为该测试 QQ 号）。 */
export function privateMessage(text) {
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
export function privateMessageWithImage(url, { text = '你看这个', summary = '[动画表情]', file = 'AB12CD34.png', fileSize } = {}) {
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
export function privateMessageWithReply(text, quotedId) {
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
export function groupMessage(segments, { userId = 100000003, name = 'tomori', card = 'kaguya', messageId = 7000 } = {}) {
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
export function mention(text, options) {
  return groupMessage([{ type: 'at', data: { qq: SELF_ID, name: '小助手' } }, { type: 'text', data: { text } }], options);
}


/** 模拟 Harness 跑完一轮：认领最新一条入站消息 → 产出 assistant 文本 → turn 结束。 */
export function completeTurn(host, agent, text, turn = 1) {
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
export function sentTexts(onebot, action = 'send_group_msg') {
  return onebot.calls.filter((call) => call.action === action).map((call) => call.params.message);
}


/**
 * 所有起过的插件实例：用例结束时统一收尾。
 *
 * 插件会持有 OneBot socket（以及主动说话、补一句那些短定时器），
 * 测试里没人卸载插件，这些监听中的句柄会让**测试进程**一直不退出 —— 所以这里
 * 统一在 `after` 里把每个实例的 `ctx.effect` 销毁回调跑一遍、关掉假服务端。
 */
export const liveBoots = [];


/**
 * 起一个插件实例：接上全新的假 OneBot 服务端、假 Host 与临时会话根目录，并等它完成身份识别。
 * @param config - 插件配置（会与下面的测试默认值合并）。
 * @param hostOptions - 假 Host 的选项（工具表、预设平面…）。
 * @param onebotOptions - 假 OneBot 服务端的选项（例如 `get_image` 的桩）。
 */
export async function boot(config = {}, hostOptions = {}, onebotOptions = {}) {
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
export async function waitForSelfId(host, timeoutMs = 5000) {
  const tool = host.tools.get('qq_list_conversations');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await tool.execute({}, {});
    if (value.self_id === String(SELF_ID)) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the OneBot client to learn its own id');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}


// ---------------------------------------------------------------------------
// 自动复读：群里连着出现同一条消息（或同一张表情包）时跟着复读，不经过 Agent
// ---------------------------------------------------------------------------

/** 「群里有人发了一条纯文字消息」。 */
export function groupText(text, options) {
  return groupMessage([{ type: 'text', data: { text } }], options);
}


/** 等一小会儿，用来断言「这段时间里什么都没发出去」。 */
export async function settle(ms = 120) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}


// ---------------------------------------------------------------------------
// 表情包复读：连着两张一样的表情包/图片，就跟着把这张发回去
// ---------------------------------------------------------------------------

/** 「群里有人只发了一张图」。默认是一张收藏表情（NapCat 上报的 `sub_type: 1`）。 */
export function groupSticker(url, { messageId = 7000, userId = 100000003, card = 'kaguya', summary = '[动画表情]', file = 'A.png', subType = 1 } = {}) {
  return groupMessage([{ type: 'image', data: { summary, file, url, sub_type: subType } }], { messageId, userId, card });
}


/** 从一条出站消息里取出图片字节（`base64://` 解回来）。 */
export function sentImageBytes(call) {
  assert.equal(call.params.message[0].type, 'image');
  return Buffer.from(call.params.message[0].data.file.replace('base64://', ''), 'base64');
}


// ---- 表情包 / 发图：工作目录里的图 → QQ --------------------------------------
// 上面的媒体用例是入站（QQ 的图 → 本地文件），这一组是出站（本地文件/URL → QQ）。
// 传输走 OneBot image 段的 `base64://`（NapCat 在容器里，本地路径它读不到），
// 所以这里真正要钉住的是：发出去的确实是一个 image 段，且 base64 解出来是原字节。

/**
 * 起一个「有表情包」的插件实例：cwd 是新临时目录，里面放一张真 PNG 与一个假图片。
 * @param config - 插件配置（覆盖默认的 cwd）。
 */
export async function bootImages(config = {}, hostOptions = {}, onebotOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-image-'));
  await mkdir(join(cwd, '.qq-stickers'), { recursive: true });
  await writeFile(join(cwd, '.qq-stickers', '笑死.png'), TINY_PNG);
  await writeFile(join(cwd, 'notes.txt'), 'definitely not an image');
  // 表情包行为用例默认关掉心情门控：这些用例考的是「目录 / 存图 / 发送格式」，
  // 不是「这一轮有没有放行」。门控本身在 bridge-mood.test.mjs 里单独考，
  // 要验「默认关闭」的用例显式传 `moduleEmojiMood: true` 覆盖即可。
  const booted = await boot({ cwd, moduleEmojiMood: false, ...config }, hostOptions, onebotOptions);
  return { ...booted, cwd };
}


// ---- 长期记忆：转录 → 工具 → 定时摘要 -------------------------------------------------

/**
 * 起一个开了长期记忆的实例：cwd 是新的临时目录，`.qq-memory` 就落在里面。
 *
 * 默认 `digestCatchUp: false` —— 补课会在第一条消息到达时就摘要一次，用例希望自己
 * 决定什么时候触发摘要（`host.list.timers.fireInterval()`）；要验补课就显式打开。
 */
export async function bootMemory(config = {}, hostOptions = {}, onebotOptions = {}, seed) {
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
export function msUntilHour(hour) {
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}


/** 读 `.qq-memory/` 里的一个文件；不存在时抛错（用例里通常意味着「本该写出来」）。 */
export async function readMemory(cwd, relative) {
  return readFile(join(cwd, '.qq-memory', relative), 'utf8');
}


/** 等 `.qq-memory/digest.json` 里出现某个会话的摘要记录（摘要跑完了）。 */
export async function waitForDigestRecord(cwd, key) {
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
export function localDateOf(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}


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
export async function bootProactive(config = {}, hostOptions = {}, onebotOptions = {}) {
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
export async function groupWhereBotSpoke(onebot, host, botReply = '在的') {
  onebot.push(mention('在吗'));
  const agent = await until(() => host.list.created[0], 'the group Agent to be created');
  await until(() => agent.inbox.length >= 1, 'the first turn to be submitted');
  completeTurn(host, agent, botReply);
  await until(() => sentTexts(onebot).length >= 1, 'the first reply to go out');
  await settle(30);
  return agent;
}


/** 另一个群友在群里说一句（没 @ 机器人）—— 「群里还有人说话」的信号。 */
export async function groupChatter(onebot, text = '今晚吃啥', { messageId = 7001 } = {}) {
  onebot.push(groupText(text, { messageId, userId: 10001, card: 'soyo' }));
  await settle(80);
}



// ---- 活跃对话：聊起来之后保持搭话 -------------------------------------------------------

/**
 * 起一个「活跃对话」实例。
 *
 * A（免 @ 接话）默认开着；B（补一句）默认关（`activeChimeIdleMs: 0`），要验它的用例自己
 * 打开并把静默门槛压到几十毫秒 —— 默认值是 20 秒，用例不可能真等。`delayJitter: 0` 用来
 * 把补一句的延迟钉死，不然它是 20 秒 ± 40%。
 */
export async function bootActive(config = {}, hostOptions = {}, onebotOptions = {}) {
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


// ---- 免 @ 搭话的抽卡：够资格之后还要掷一次累计概率（见 speaking-rules.js）----------------
//
// 上面的多人搭话 / 免 @ 接话用例把 `activeTalkChance` 钉成 1，验的是门槛与记账本身；
// 下面这几条专门验概率曲线：没抽中就不接、连丢越多越容易中、抽中与被 @ 到之后归零、
// 对话凉了不把「保底」留到下一场。

/** 搭话抽卡：0 起、每条 +1（= 连丢一条之后必中），下面几条用例都靠它做到完全确定。 */
export function talkRollConfig(overrides = {}) {
  return { activeTalkChance: 0, activeTalkChanceStep: 1, activeTalkChanceMax: 1, ...overrides };
}


// ---- 每天轮换 API key：凭据池 → 探测 → 写回 --------------------------------------------

/**
 * 造一个假的凭据服务，形状照抄 `$DSH_HOME/.credentials.yaml` 那一层的对外 API：
 * `resolve` 读值、`set` 写值、`describe` 回答「写进去会不会被启动环境压住」。
 *
 * `calls` / `resolves` 是给用例看的账本 —— 「有没有真的写」这件事只能从这里看，
 * 因为插件从不打印 key 本身。
 */
export function fakeCredentials({ value = '', writable = true, source = 'file' } = {}) {
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
export async function startProbeServer(statusForKey) {
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
export async function bootKeyRotation({ pool, credentials, config = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-bridge-keys-'));
  if (pool !== undefined) {
    await mkdir(join(cwd, 'data'), { recursive: true });
    await writeFile(join(cwd, 'data', 'api-keys.txt'), pool, 'utf8');
  }
  return boot({ cwd, memory: false, apiKeyRotate: true, ...config }, { credentials });
}


// ---- NapCat 那一侧的自检（启动时读一眼，默认只读）-------------------------------------
//
// 「它为什么不说话」里最常见的一环就在另一个软件里：插件这边全都配好了，但 NapCat
// 里没有一条启用的 WebSocket 服务器。这里验的是**接线**（index.js 有没有真的跑那次
// 自检、有没有把结论写进日志）；判据本身的边界在 test/napcat.test.mjs 里。

/** 造一个假的 NapCat 安装目录：`<root>/config/onebot11_<qq>.json`。 */
export async function fakeNapcatConfig(config, qq = '10001') {
  const root = await mkdtemp(join(tmpdir(), 'qq-bridge-napcat-'));
  const dir = join(root, 'config');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `onebot11_${qq}.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { root, dir, file };
}


/** 一条「什么都没配」的 onebot11 配置。 */
export const NAPCAT_EMPTY = { network: { httpServers: [], websocketServers: [], websocketClients: [] }, enableLocalFile2Url: false };


// 「已经配好了就只记一句 info、不刷 warn」这一条没有放在这里：假 OneBot 用的是系统分配的
// 随机端口，而这个用例需要**先知道端口**才能把 NapCat 的配置写成「已经对了」的样子，
// 在 boot() 之后再改配置又赶不上那次自检。它由 test/napcat.test.mjs 的
// `repairNapcat` → `action: 'ok'`（幂等、不产生第二个备份）覆盖。


// ---- 插话的准入与指向（§7.1 / §7.3 / §7.5）------------------------------------

/**
 * 起一个「群已经聊热、插话必中」的实例，并让它被 @ 过一次（这样会话记录与一对一窗口都在）。
 * @returns `{ onebot, host, agent }`：已经回完一轮的实例。
 */
export async function bootHotGroup(overrides = {}) {
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


// ---- 感知与互动：戳一戳 / 链接 / 视频封面 / 语音（§8）------------------------

/** 造一条戳一戳的通知事件（OneBot v11 的 notice/notify/poke）。 */
export function pokeNotice({ userId = 100000002, targetId = SELF_ID, groupId, name = 'iroha' } = {}) {
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


// ---- 人格与表达的提示词槽位（P3）-----------------------------------------------

/** 造一份人设文件与一份表达文件（放在一个临时 cwd 的 `.qq-persona/` 下）。 */
export async function bootWithPersona(config = {}, hostOptions = {}, onebotOptions = {}) {
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


// ---- 被撤回的消息（见 docs/recall.md）--------------------------------------------
//
// 这一组钉的是三层里**最难从代码看出来**的那部分：撤回落在「待回批次 / 在飞 / 已回复」
// 三个不同位置时行为不同，而「不引用一条已撤回的消息」是正确性问题 —— 引用失败会让
// 整条回复剩下的气泡一起发不出去（§1.4）。
//
// 与 `bootProactive` 同款：`digestMinLines` 抬到很高，免得假定时器把摘要循环顺带跑起来。

/** 起一个开了撤回处理的实例；闸门默认全部放宽，要验哪道就自己收紧。 */
export async function bootRecall(config = {}, hostOptions = {}, onebotOptions = {}) {
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
export function groupRecall({ messageId = 7000, userId = GROUP_USER_ID, operatorId } = {}) {
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
export function quotedAny(onebot) {
  return onebot.calls.some(
    (call) =>
      call.action === 'send_group_msg'
      && Array.isArray(call.params.message)
      && call.params.message.some((segment) => segment?.type === 'reply'),
  );
}


/** 造一条私聊撤回通知（`friend_recall` 没有 group_id，也没有 operator_id）。 */
export function privateRecall({ messageId = 7100, userId = PRIVATE_USER_ID } = {}) {
  return { post_type: 'notice', notice_type: 'friend_recall', user_id: userId, message_id: messageId };
}


// ---- 定时提醒 -----------------------------------------------------------------

/**
 * 起一个群会话并把它那一轮回复跑完。
 *
 * 提醒测试需要两件事：`conversation.speakers` 已经登记（创建者是谁），以及
 * **没有在飞的 turn**（否则 agent 模式会被 `busyWithTurn` 挡回固定文案）。
 */
export async function bootGroupConversation(config = {}) {
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
export function fireSchedulerAfter(host, ms) {
  const real = Date.now;
  try {
    Date.now = () => real() + ms;
    host.list.timers.fireTimeout();
  } finally {
    Date.now = real;
  }
}


/** 手动触发 agent 提醒的守卫（超时那条），只认 120 秒以上的 timeout。 */
export function fireReminderGuard(host) {
  const guard = host.list.timers.live('timeouts').find((entry) => entry.delay >= 90_000);
  assert.ok(guard, 'the reminder guard should be armed');
  guard.callback();
}

/**
 * 收掉本进程里所有起过的插件实例：跑掉插件的 `ctx.effect` 销毁回调、关掉假服务端。
 *
 * 插件会持有 OneBot socket（以及主动说话、补一句那些短定时器），测试里没人卸载插件，
 * 这些监听中的句柄会让**测试进程**一直不退出 —— 所以每个用例文件都要在 `after` 里调它。
 */
export async function cleanupBoots() {
  for (const instance of liveBoots.splice(0)) {
    instance.host.list.stop?.();
    await instance.onebot.close().catch(() => {});
  }
}
