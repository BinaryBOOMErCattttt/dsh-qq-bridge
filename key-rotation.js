/**
 * 每天轮换模型凭据：池子 → 探测 → 写回 → 每日定时器。
 *
 * 为什么能这么做：Harness 的模型调用是**每次请求**去解析凭据的
 * （llm-deepseek 的 resolveApiKey → ctx.credentials.resolve），而本地凭据层监听
 * `$DSH_HOME/.credentials.yaml`、写完就地更新内存 —— 所以把新 key 交给 credentials
 * 服务就等于当场生效，不用重启 Harness。反过来，自己去改那个 YAML 文件是不行的：
 * 里面还有浏览器会话等 records，手写一份很容易把它们弄丢，也绕过了凭据层自己的文件锁。
 *
 * 池子是 cwd 里的一个纯文本文件，而不是配置项：配置会显示在 Web UI 上、也会被复制粘贴
 * 到别处，key 不该走那条路。它同时也必须在 cwd 内（与该目录的其它约定一致）。
 *
 * 从 `index.js` 搬出来：这一整块（池子解析、探测、轮换、定时器、启动自述）与闭包的关系
 * 只有「读哪些配置、往哪写日志、拿 ctx 的 credentials / timer」这几件事。`index.js`
 * 只剩一行 `createKeyRotation({ … })` 与 `start()`。
 *
 * @module @qqbot/dsh-plugin-qq/key-rotation
 */
import { relative, resolve, sep } from 'node:path';
import { readTextOrUndefined } from './filestore.js';
import {
  apiKeyFingerprint,
  errorText,
  hourLabel,
  msUntilDailyHour,
  parseApiKeyPool,
  pathInside,
} from './util.js';

/**
 * 建立轮换器。
 *
 * @param deps - `ctx`（credentials 服务 + effect / interval）、`settings`、`cwd`、
 *   `report(level, message)`。
 * @returns `{ enabled, rotate(reason), start() }`：`start()` 挂每日定时器并写启动自述。
 */
export function createKeyRotation({ ctx, settings, cwd, report }) {
  const apiKeyRotateOn = settings.apiKeyRotate !== false;
  const apiKeyRefName = typeof settings.apiKeyRef === 'string' ? settings.apiKeyRef.trim() : '';
  // 凭据引用名与凭据层自身的语法一致（也是 POSIX 环境变量名）：不合法就整个停用，
  // 而不是每天写一个语法都不对的 ref 进去。
  const apiKeyRefValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyRefName);
  const apiKeyPoolCfg = typeof settings.apiKeyFile === 'string' ? settings.apiKeyFile.trim() : '';
  const apiKeyPoolPath = apiKeyPoolCfg.length > 0 ? resolve(cwd, apiKeyPoolCfg) : undefined;
  const apiKeyPoolInside = apiKeyPoolPath !== undefined && pathInside(resolve(cwd), apiKeyPoolPath);
  /** 池子的展示路径（相对 cwd、正斜杠），日志与「怎么配」的提示里都用它。 */
  const apiKeyPoolLabel = apiKeyPoolInside ? relative(resolve(cwd), apiKeyPoolPath).split(sep).join('/') : apiKeyPoolCfg;
  const apiKeyRotateEnabled = apiKeyRotateOn && apiKeyRefValid && apiKeyPoolInside;
  if (apiKeyRotateOn && !apiKeyRefValid) {
    report('warn', `apiKeyRef "${apiKeyRefName}" is not a credential name (A-Za-z_ followed by A-Za-z0-9_); api key rotation is disabled`);
  } else if (apiKeyRotateOn && !apiKeyPoolInside) {
    report('warn', `apiKeyFile "${apiKeyPoolCfg}" resolves outside cwd (${cwd}); api key rotation is disabled`);
  }

  /**
   * 探测一个候选 key 现在能不能用。
   *
   * 用 GET 而不是发一次真的对话：「换 key」最怕的是从一个没额度的 key 换到另一个同样
   * 没额度的 key，所以探测必须**便宜且不消耗 token**。DeepSeek 的 OpenAI 兼容面
   * （`/models`）认 `Authorization: Bearer`，Anthropic 面认 `x-api-key` —— 两个头一起
   * 带上，同一套配置就能探两种协议（多出来的那个头会被服务端忽略）。
   *
   * 判定：2xx = 可用；429 = key 本身有效但被限流/额度用尽，对「找一个现在能用的」来说
   * 同样算不可用，但日志里要区分出来 —— 那说明池子里这个 key 该换了，而不是写错了。
   * @param key - 候选 key。
   * @returns `{ ok, detail }`：detail 是可以直接写进日志的一句话。
   */
  async function probeApiKey(key) {
    const url = settings.apiKeyProbeUrl;
    if (url.length === 0) return { ok: true, detail: 'probe disabled' };
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
        signal: AbortSignal.timeout(settings.apiKeyProbeTimeoutMs),
      });
      // 响应体一律不要（`/models` 的列表又长又没用），但也不能让连接挂着不给个交代。
      if (response.body !== null) {
        try {
          await response.body.cancel();
        } catch {
          // 取不取消都不影响判定：状态码已经拿到了。
        }
      }
      if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
      return { ok: false, detail: response.status === 429 ? 'HTTP 429 (额度用尽或被限流)' : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `probe failed: ${errorText(error)}` };
    }
  }

  /**
   * 每天到点尝试把当前凭据换成池子里的下一个 key。
   *
   * 「尝试」的含义就在这两个循环里：从**当前生效的 key 之后**开始，逐个探测池子里的候选，
   * 第一个探测通过的才写进去；全都不通过就保留原来的、只记一条 warn。这样池子里混进一个
   * 失效的 key 不会把 bot 直接换成不可用的状态，也不会因为一行坏 key 就每天卡在同一个位置。
   *
   * 状态是**算出来的**，不落盘：当前用的是哪个 key 直接问凭据层要，下一个是谁由它在池子里的
   * 位置决定。于是重启、手工改过 key、池子刚调整过顺序都不会让轮换跑偏（当前 key 不在池子里
   * 时从池首开始）。
   * @param reason - 写进日志的触发原因（例如 `daily at 04:00`）。
   */
  async function rotate(reason) {
    if (!apiKeyRotateEnabled) return;
    const text = await readTextOrUndefined(apiKeyPoolPath);
    // 「文件还没有 / 还没填 key」是**没配置**而不是故障：记 info，把「该怎么办」说清楚，
    // 别让使用者每天在 journal 里看到一条红黄的 warn 却不知道要做什么。
    if (text === undefined) {
      report('info', `api key rotation (${reason}): no key pool at ${apiKeyPoolLabel}; put one key per line there to start rotating`);
      return;
    }
    const pool = parseApiKeyPool(text);
    if (pool.length === 0) {
      report('info', `api key rotation (${reason}): key pool ${apiKeyPoolLabel} has no key yet (comments and blank lines do not count)`);
      return;
    }
    const credentials = ctx.get('credentials');
    if (credentials === undefined || typeof credentials.set !== 'function' || typeof credentials.resolve !== 'function') {
      report('warn', `api key rotation: the credentials service is not visible from this plugin, cannot switch ${apiKeyRefName}`);
      return;
    }
    // describe() 能直接回答「写进去会不会被启动环境压住」：环境变量里的 DEEPSEEK_API_KEY
    // 优先级高于凭据文件，那种部署下写文件等于白写 —— 提前说清楚，而不是每天静默地
    // 「成功」换了一个根本不生效的 key。
    if (typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(apiKeyRefName);
        if (info?.writable === false) {
          report('warn', `api key rotation: ${apiKeyRefName} is supplied read-only by the launching environment (source ${info.source ?? 'env'}); rotating the stored value would have no effect`);
          return;
        }
      } catch (error) {
        report('warn', `api key rotation: could not inspect ${apiKeyRefName}: ${errorText(error)}`);
        return;
      }
    }
    let current = '';
    try {
      current = (await credentials.resolve(apiKeyRefName))?.value ?? '';
    } catch (error) {
      report('warn', `api key rotation: could not read the current ${apiKeyRefName}: ${errorText(error)}`);
      return;
    }
    const currentLabel = current.length > 0 ? apiKeyFingerprint(current) : '(未设置)';
    // 候选顺序：当前 key 的下一个开始，绕回池首。当前 key 不在池子里（手工填的、或者
    // 池子刚换过）时从第一个开始 —— 池子里的顺序就是轮换顺序。
    const start = current.length > 0 && pool.includes(current) ? (pool.indexOf(current) + 1) % pool.length : 0;
    const order = [];
    for (let step = 0; step < pool.length; step += 1) {
      const candidate = pool[(start + step) % pool.length];
      if (candidate !== current) order.push(candidate);
    }
    if (order.length === 0) {
      report('info', `api key rotation: ${apiKeyPoolLabel} holds no key other than the one in use (${currentLabel}); nothing to rotate`);
      return;
    }
    for (const candidate of order) {
      const probe = await probeApiKey(candidate);
      if (!probe.ok) {
        report('warn', `api key rotation: candidate ${apiKeyFingerprint(candidate)} rejected (${probe.detail}); trying the next one`);
        continue;
      }
      try {
        await credentials.set(apiKeyRefName, candidate);
      } catch (error) {
        report('warn', `api key rotation: could not store ${apiKeyRefName}: ${errorText(error)}`);
        return;
      }
      // 写回之后回读一次：凭据层的写入是异步的（落盘 + 通知），确认真的换过去了才算成功。
      const after = await credentials.resolve(apiKeyRefName).catch(() => undefined);
      if (after?.value !== candidate) {
        report('warn', `api key rotation: ${apiKeyRefName} still reads back as the old value after a write; the credentials store did not take it`);
        return;
      }
      report('info', `api key rotation: switched ${apiKeyRefName} from ${currentLabel} to ${apiKeyFingerprint(candidate)} (${probe.detail})`);
      return;
    }
    report('warn', `api key rotation: none of the ${order.length} other key(s) in ${apiKeyPoolLabel} passed the probe; keeping ${currentLabel}`);
  }

  /**
   * 挂每日定时器并写启动自述。
   *
   * 与摘要循环同一套托管方式（`ctx.interval` + 「跑完再排」，插件卸载即清掉），只是没有
   * 任何预热：轮换的状态全部现算（见 `rotate`），重启也不会跑偏。
   */
  function start() {
    if (apiKeyRotateEnabled) {
      const hour = settings.apiKeyRotateHour;
      const tick = () => {
        // 定时器回调是同步的，而轮换要读盘 + 发探测请求：这里只负责把异常收进日志，
        // 不让一个 rejected promise 变成 unhandled rejection 把进程带走。
        void rotate(`daily at ${hourLabel(hour)}`).catch((error) => {
          report('warn', `api key rotation failed: ${errorText(error)}`);
        });
      };
      let rotateTimerDisposer;
      ctx.effect(() => {
        // 每天醒一次，醒来跑完再排下一次：每次算的都是「距离下一个整点还有多久」，
        // 所以刚过点时会排到明天，不会在同一个点上反复醒。
        const schedule = () => {
          const wait = msUntilDailyHour(hour);
          if (typeof ctx.interval === 'function') {
            rotateTimerDisposer = ctx.interval(() => {
              rotateTimerDisposer?.();
              tick();
              schedule();
            }, wait);
            return;
          }
          // 没有 timer 服务（测试桩或最小组合）时退回裸定时器：同样是「跑完再排」。
          const handle = setTimeout(() => {
            tick();
            schedule();
          }, wait);
          handle.unref?.();
          rotateTimerDisposer = () => clearTimeout(handle);
        };
        schedule();
        return () => {
          rotateTimerDisposer?.();
          rotateTimerDisposer = undefined;
        };
      }, 'qq-bridge:api-key-rotate');
      report(
        'info',
        `api key rotation: on, daily at ${hourLabel(hour)} — pool ${apiKeyPoolLabel}, ref ${apiKeyRefName}, ` +
          `probe ${settings.apiKeyProbeUrl.length > 0 ? settings.apiKeyProbeUrl : '(disabled)'}`,
      );
    } else if (apiKeyRotateOn) {
      // 配置本身不合法（ref 不是变量名 / 池子在 cwd 外）：创建时已经逐条 warn 过，这里不重复。
    } else {
      report('info', 'api key rotation is off (apiKeyRotate is false)');
    }
  }

  return { enabled: apiKeyRotateEnabled, rotate, start };
}
