/**
 * QQ Bridge —— QQ（OneBot v11）与 Harness Agent 之间的双向桥接插件。
 *
 * 入站（QQ → Agent）：每个 QQ 会话（一个私聊对象，或一个群）独占一个持久化
 * Harness Session。收到的消息按会话串行投递给该 Session 的 Agent，等这一轮
 * turn 结束后，把最后一条有文本的 assistant 回复发回 QQ。
 *
 * 出站（Agent → QQ）：注册两个全局工具，任何 Harness Agent 都能主动发 QQ
 * 消息、按需查询当前在线的好友/群列表。
 *
 * 文件结构（自上而下）：
 *   1. 插件身份与配置 schema（name / inject / Config）
 *   2. 纯函数工具（sessionIdFor / visibleText）
 *   3. apply()：闭包内维护全部运行时状态、事件路由与工具注册
 *
 * 媒体（图片/表情包的下载与本地缓存）单独放在 `media.js`：那部分只关心「字节从哪来、
 * 落到哪个文件」，与 OneBot 事件路由无关；这里只负责在入站时调用它，并把路径拼进正文。
 *
 * @module @qqbot/dsh-plugin-qq
 */
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, rm, stat } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { OneBotClient, chunkText, collectMedia, mediaPlaceholder, mentions, messageToText, splitBurst, typingDelayMs } from './onebot.js';
import { createMediaStore } from './media.js';
import { createJmService, parseJmRef } from './jm.js';

/** 插件在 Loader 中的稳定标识（改名会导致配置/状态对不上）。 */
export const name = 'qq-bridge';

/** 激活前必须就绪的 Host 服务：注册工具需要 tools，创建会话需要 agents。 */
export const inject = ['tools', 'agents'];

/**
 * 系统提示中「QQ 渠道」小节的排序值：靠后，但仍排在交付物/Web 相关小节之前。
 * 数值越大越靠后，具体取值只需与部署里其它小节的排序错开即可。
 */
const CHANNEL_SECTION_ORDER = 8950;

/**
 * `agentPreset` 配置的哨兵值：不挂载任何预设。
 * 用于明确要求「QQ 会话只用宿主平面的工具」（例如自建部署里预设平面不存在，
 * 或使用者故意不给它任何文件/联网能力）。
 */
const PRESET_NONE = 'none';

/**
 * 默认的「群友口吻」要求，注入系统提示的 QQ 渠道小节。
 * 配置里的 `persona` 非空时整段替换它（格式与身份红线仍然保留，见 channelPrompt）。
 */
const DEFAULT_PERSONA = [
  '说话方式（像真人群友一样）：',
  '- 短。一般一两句话，能一句说完就别用三句。',
  '- 口语。用平时聊天的说法，可以有「啊 / 吧 / 呢 / 嘛 / 草 / 笑死」这类语气词。',
  '- 不用每句都答得很完整：可以吐槽、可以接梗、可以反问、可以敷衍，也可以只回两个字。',
  '- 不要列点、不要总结、不要「首先 / 其次 / 总之」，不要写小作文。',
  '- 不用每次都热情帮忙或给建议，群友之间经常只是搭一句话。',
  '- 别复述对方的话，别用「关于你提到的问题」这种书面腔。',
].join('\n');

/**
 * 插件配置的校验 schema（bundle 的 config: 段或 Web UI 插件设置里填写）。
 * 这里同时充当配置文档：每个字段的 .description 会显示在界面上给使用者看。
 */
export const Config = z.object({
  endpoint: z.string().default('ws://127.0.0.1:3001').description('OneBot v11 正向 WebSocket 地址（NapCat 的 websocketServers 端口）'),
  accessToken: z.string().default('').description('OneBot access_token；NapCat 未设置 token 时留空'),
  cwd: z.string().default('').description('QQ 会话 Agent 的工作目录；留空则使用 Harness 进程的当前目录'),
  privateChat: z.boolean().default(true).description('是否响应 QQ 私聊消息'),
  groupChat: z.boolean().default(true).description('是否响应 QQ 群消息'),
  groupTrigger: z.union(['mention', 'prefix', 'all']).default('mention').description('群消息触发方式：@机器人 / 前缀 / 全部消息'),
  prefix: z.string().default('/').description('groupTrigger=prefix 时使用的前缀'),
  allowUsers: z.array(z.string()).default([]).description('私聊白名单（QQ 号）；留空表示不限制'),
  allowGroups: z.array(z.string()).default([]).description('群白名单（群号）；留空表示不限制'),
  provider: z.string().default('').description('QQ 会话使用的模型服务商；留空使用默认'),
  model: z.string().default('').description('QQ 会话使用的模型；留空使用默认'),
  approvalPolicy: z.union(['never', 'inherit']).default('never').description('QQ 会话的工具审批策略：never 表示无人值守时一律拒绝需要审批的操作'),
  agentPreset: z.string().default('').description('QQ 会话 Agent 挂载的 Agent 预设 id（本 bundle 自带 qq：只读文件 + 检索 + 联网）；留空表示用部署的默认预设；填 none 表示不挂载预设（QQ 会话将只有宿主平面的全局工具）'),
  allowTools: z.array(z.string()).default([]).description('QQ 会话 Agent 可用的工具白名单（工具名）；留空表示不限制，非空时未列出的工具一律对 QQ 会话隐藏'),
  resetCommand: z.string().default('/reset').description('清空当前 QQ 会话记忆的指令：在 QQ 里单独发送该指令即生效；留空表示禁用'),
  maxReplyChars: z.number().default(1500).description('单条 QQ 消息的最大字符数（协议上限），超出自动分段'),
  // ---- 图片/表情包：下载到本地，让 Agent 能用 read_image 真的看见 ----
  mediaDownload: z.boolean().default(true).description('是否把 QQ 消息里的图片/表情包下载到本地（模型只能读本地文件，不下载就只看到一句占位符）'),
  mediaDir: z.string().default('.qq-media').description('媒体缓存目录，相对 cwd（必须落在 cwd 内，否则自动停用下载）'),
  mediaMaxBytes: z.number().default(8 * 1024 * 1024).description('单个图片/表情包的字节上限，超过就不下载（只留占位符）'),
  mediaCacheFiles: z.number().default(200).description('媒体缓存最多保留多少个文件，超出按最近使用时间淘汰最旧的'),
  mediaTimeoutMs: z.number().default(15000).description('单个媒体的下载超时（毫秒）'),
  // ---- 以下为「像真人一样在群里说话」的开关，默认全部开启 ----
  ambientMessages: z.number().default(12).description('群聊里注入给 Agent 的最近消息条数（让它知道大家在聊什么，不只是被 @ 的那一句）；0 = 关闭'),
  ambientLineChars: z.number().default(120).description('群聊上下文里每条消息最多保留的字符数'),
  humanize: z.boolean().default(true).description('自动回复是否像真人：按换行/短句拆成几条独立消息并加入打字延迟（换行 = 分条）；false = 一条整段直接发出（旧行为）'),
  burstMaxChars: z.number().default(60).description('把一行长句拆开时的单条目标长度；0 = 不按长度拆（换行仍然分条）'),
  burstMaxParts: z.number().default(3).description('单行长句最多拆成几条；超出部分并进该行最后一条，避免刷屏'),
  readDelayMs: z.number().default(800).description('发出第一条前的「读消息」基础延迟（毫秒）'),
  charsPerSecond: z.number().default(15).description('模拟打字速度（字符/秒），用于按字数计算每条消息发出前的延迟'),
  minDelayMs: z.number().default(300).description('单条消息前延迟的下限（毫秒）'),
  maxDelayMs: z.number().default(5000).description('单条消息前延迟的上限（毫秒）'),
  delayJitter: z.number().default(0.4).description('延迟的随机抖动比例（0 = 固定延迟，0.4 = 上下浮动 40%）'),
  replyStyle: z.union(['auto', 'plain', 'quote', 'at']).default('auto').description('群聊回复的指向方式：auto = 只在「回的那条后面又有人说话」时才引用（默认），quote = 引用被回复的那条消息，at = @ 对方，plain = 直接发；指向只挂在第一条上，私聊始终为 plain'),
  persona: z.string().default('').description('替换默认的「群友口吻」段落；留空使用插件内置的那份'),
  instructions: z.string().default('').description('追加到 QQ 会话系统提示的额外要求'),
  // ---- 禁漫（JM / 18comic）下载 → PDF → 发到 QQ ----
  // 依赖外部 python：见 README「禁漫下载」。关掉 jmDownload 后一条网络请求都不会发。
  jmDownload: z.boolean().default(true).description('是否启用禁漫（JM）下载：把整本/单话合并成 PDF 并发到 QQ'),
  jmCommand: z.string().default('/jm').description('QQ 里直接触发下载的指令（如 `/jm 422866`，也接受 18comic 链接）；留空表示禁用该指令，只保留 Agent 工具'),
  jmDir: z.string().default('.qq-jm').description('禁漫 PDF 的存放目录，相对 cwd（必须落在 cwd 内，否则自动停用）'),
  jmPython: z.string().default('.venv/bin/python').description('跑 jmcomic 的 python 解释器：绝对路径，或相对 cwd（仓库自带 .venv）'),
  jmScript: z.string().default('').description('下载脚本路径；留空使用插件自带的 scripts/jm_download.py'),
  jmMaxChapters: z.number().default(0).description('整本下载的话数上限；0 = 不限制（超出时回一句提示而不是闷头下几百话）'),
  jmMaxPages: z.number().default(0).description('单次下载的总页数上限；0 = 不限制'),
  jmTimeoutMs: z.number().default(15 * 60 * 1000).description('单次下载的硬超时（毫秒），到点强杀 python 子进程'),
  jmRequestTimeoutMs: z.number().default(30000).description('jmcomic 单次 HTTP 请求超时（毫秒）'),
  jmUploadTimeoutMs: z.number().default(10 * 60 * 1000).description('把 PDF 交给 NapCat 上传的超时（毫秒）；NapCat 拉完文件才回响应，大文件要慢慢等'),
  jmMaxFiles: z.number().default(20).description('PDF 目录最多保留几个文件，超出按最近使用时间淘汰最旧的'),
  jmMaxJobs: z.number().default(1).description('同时进行的下载数上限（多个会话同时点车时排队，而不是一起压到禁漫）'),
  jmFileHost: z.string().default('172.17.0.1').description('NapCat 取 PDF 时访问的地址：容器里要能连到宿主机，默认 docker 网桥 172.17.0.1（只在本机容器网段可达）'),
  jmFilePort: z.number().default(0).description('给 NapCat 用的 HTTP 文件服务端口；0 = 由系统分配'),
  jmUrlTtlMs: z.number().default(10 * 60 * 1000).description('交给 NapCat 的一次性下载 URL 有效期（毫秒）'),
});

/**
 * 由会话 key 派生出稳定的、UUID 形状的 Session id。
 *
 * 确定性正是关键：同一个 QQ 会话在 Harness 反复重启后仍然得到同一个
 * Session id，因此可以 resume 历史会话，聊天记忆不会丢。
 * 做法是把 SHA-256 摘要裁剪成 UUID 形状，并把版本位/变体位写成固定值，
 * 以便通过 Harness 对 session id 的格式校验。
 *
 * @param key - 会话 key，例如 `group:100000001`。
 * @returns 版本 5 形状的 UUID 字符串。
 */
function sessionIdFor(key) {
  const hex = crypto.createHash('sha256').update(`dsh-qq-bridge:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 把一条 assistant 消息里可见的文本块拼起来。
 * 工具调用、思考等非 text 块都会被忽略。
 * @param content - 持久化消息的 content 块数组。
 * @returns 拼接后的可见文本（已 trim）。
 */
function visibleText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 把任意异常压成一行短文本：日志与 QQ 回复都用它，避免把多行堆栈糊进聊天。
 * @param error - 任意抛出物。
 * @returns 单行、最多 200 字的说明。
 */
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/**
 * 在一个 Harness Host 组合上注册 QQ 桥接。
 * @param ctx - 插件上下文（tools / agents / logger / 事件总线）。
 * @param config - 已通过 Config 校验的 bundle 配置。
 */
export function apply(ctx, config) {
  const logger = ctx.logger;

  /**
   * 运维可见的运行日志：logger + 一行 stderr。
   *
   * 这个部署（`dsh-web-app` 表面）没有把 cordis 的 logger 接到 stdout/stderr 上：
   * 实测 `ctx.logger.warn()` 只进内存缓冲与 OTel，`journalctl --user -u qqbot` 里
   * 一个字都看不到 —— 而排查「QQ 会话怎么突然没能力了」只能靠 journal。
   * 所以每条日志除了 logger 之外再直接写一行 stderr（systemd 收进 journal；
   * 前台运行时就是终端）。
   *
   * 只有真实宿主里 cordis 的 LoggerService 门面才带 `exporter()`；测试用的日志桩
   * 没有，于是测试输出不会被这些行淹没。
   */
  const mirrorToStderr = typeof logger.exporter === 'function';

  /**
   * @param level - logger 方法名：info / warn / error。
   * @param message - 不含 `qq-bridge: ` 前缀的正文。
   */
  function report(level, message) {
    logger[level](`qq-bridge: ${message}`);
    if (mirrorToStderr) process.stderr.write(`qq-bridge: ${message}\n`);
  }
  // cwd 留空时退回 Harness 进程当前目录；它既是 Agent 工作目录，也是沙箱根。
  const cwd = config.cwd.trim().length > 0 ? config.cwd : process.cwd();
  const approvalPolicy = config.approvalPolicy;
  // 工具白名单：去掉空白项与重复项。空数组 = 不限制，与 allowUsers / allowGroups 语义一致。
  const allowTools = [...new Set(config.allowTools.map((name) => name.trim()).filter((name) => name.length > 0))];
  // 会话重置指令：大小写不敏感，空串表示禁用。
  const resetCommand = config.resetCommand.trim().toLowerCase();
  // 部署 persona 里的 `{{model}}` 取的是 `agent.options.model`，请求路由读的也是
  // 同一组字段，所以程序化创建的 Agent 必须显式带上模型选择：否则提示词装配会
  // 失败，turn 在消息被 claim 之前就死掉。下面的 route 记录当前生效的选择，
  // 也通过 qq_list_conversations 暴露出来便于排查。
  const route = { provider: '', model: '', reasoningEffort: undefined, source: 'none', error: '' };

  /**
   * 解析 QQ 会话应当使用的 provider/model。
   * 优先用配置里显式填写的；只填了一半或都没填时，回退到部署默认选择
   * （agentDefaultModel 服务的 currentSelection()）。
   * @returns 实时更新的 route 记录，也可从 qq_list_conversations 读到。
   */
  function resolveRoute() {
    const configuredProvider = config.provider.trim();
    const configuredModel = config.model.trim();
    if (configuredProvider.length > 0 && configuredModel.length > 0) {
      Object.assign(route, {
        provider: configuredProvider,
        model: configuredModel,
        reasoningEffort: undefined,
        source: 'config',
        error: '',
      });
      return route;
    }
    let selection;
    try {
      const service = ctx.get('agentDefaultModel');
      if (service === undefined) route.error = 'service "agentDefaultModel" is not visible from this plugin';
      else selection = service.currentSelection();
    } catch (error) {
      route.error = error?.message ?? String(error);
    }
    // 只有两个字段都没配置时，才连 reasoningEffort 一起继承默认值。
    const useDefault = configuredProvider.length === 0 && configuredModel.length === 0;
    Object.assign(route, {
      provider: configuredProvider.length > 0 ? configuredProvider : (selection?.provider ?? ''),
      model: configuredModel.length > 0 ? configuredModel : (selection?.model ?? ''),
      reasoningEffort: useDefault ? selection?.reasoningEffort : undefined,
      source: selection === undefined ? 'none' : 'default',
    });
    if (selection === undefined && route.error.length === 0) route.error = 'the default model selection is empty';
    return route;
  }

  // ---- 运行时状态（全部是进程内内存态，随 Harness 重启清空，会话历史则留在磁盘上）----

  /** 会话 key（`private:<QQ号>` / `group:<群号>`）→ 会话记录。 */
  const conversations = new Map();
  /** Session id → 会话 key，用于把 session 事件路由回来源会话。 */
  const sessionIndex = new Map();
  /** `<sessionId>:<turn>` → `{ key, quote }`，标记这一轮欠 QQ 一条回复，并记住该回复谁。 */
  const turnOwners = new Map();
  /** 已提交的消息 id → `{ key, quote }`，用来把「消息被 claim」归属到对应会话。 */
  const submitted = new Map();
  /** `<sessionId>:<turn>` → 本轮已累积的 assistant 文本片段。 */
  const transcripts = new Map();
  /**
   * 群号 → 群里的最近消息（`{ name, text }`，旧 → 新）。
   *
   * 只记「不是发给机器人的」那些消息：真人回话前是先看着群里在聊什么，
   * 而不是只看到 @ 自己的那一句。缓冲单独按群号存，而不是挂在会话记录上 ——
   * 没被 @ 的消息不该因此凭空造出一条会话。
   */
  const ambient = new Map();
  /**
   * 群号 → 群里迄今收到的消息条数（单调递增的「聊天进度」）。
   *
   * `auto` 回复指向靠它判断「我回的那条后面还有没有别人说话」：入站时快照一个数，
   * 真要发出去时再读一次 —— 变大了说明中间有人插话，裸文本会让人看不出在回谁。
   */
  const chatterSeq = new Map();

  // OneBot 客户端：事件回调统一 try/catch，保证单个消息处理失败不会打穿 socket 回调。
  const client = new OneBotClient({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    // onEvent：OneBot 主动推送的事件（含消息、心跳、通知等），这里只关心 message。
    onEvent: (event) => {
      try {
        handleEvent(event);
      } catch (error) {
        report('warn', `inbound handling failed: ${error?.message ?? error}`);
      }
    },
    // onError：客户端内部错误（socket 异常、事件处理器抛错等），仅记日志。
    onError: (error) => report('warn', `${error.message}`),
    // onStateChange：连接建立/断开，用于日志与（未来）状态展示。
    onStateChange: (connected, selfId) => {
      if (connected) report('info', `connected to ${config.endpoint}${selfId ? ` as ${selfId}` : ''}`);
      else report('info', `disconnected from ${config.endpoint}`);
    },
  });

  /**
   * 图片/表情包的本地缓存。
   *
   * QQ 上报的 `image` 段里只有一串会过期的下载 URL（腾讯的 rkey 有时效），而 Agent
   * 要「看见」图只能靠 `read_image` 读本地文件 —— 这个 store 负责取字节、按内容哈希
   * 落盘、并返回相对 `cwd` 的路径。取不到时只回一句占位文本，不会打断消息链路。
   *
   * `resolveViaOneBot` 是兜底：URL 抓不动（rkey 过期、NapCat 与 Harness 不在同一台
   * 机器）时把 `file` 段原样丢回 OneBot 的 `get_image`，让它替我们下载。
   */
  const mediaStore = createMediaStore({
    cwd,
    dir: config.mediaDir,
    maxBytes: config.mediaMaxBytes,
    maxFiles: config.mediaCacheFiles,
    timeoutMs: config.mediaTimeoutMs,
    enabled: config.mediaDownload,
    report,
    resolveViaOneBot: (item) => client.call('get_image', { file: item.file }),
  });

  /**
   * 禁漫（JM）下载服务：起 python 子进程下载 → 合并 PDF → 用一次性 URL 交给 NapCat。
   *
   * 为什么绕这么大一圈：NapCat 跑在容器里，插件跑在宿主机上，`upload_private_file`
   * 只认 URL（实测传本地路径会回 `识别URL失败`）。所以 PDF 落盘之后，插件在本机
   * docker 网桥上开一个小 HTTP 服务，把文件交给 NapCat 自己来拉。
   */
  const jmService = createJmService({
    cwd,
    dir: config.jmDir,
    python: config.jmPython,
    script: config.jmScript.trim().length > 0 ? config.jmScript : fileURLToPath(new URL('./scripts/jm_download.py', import.meta.url)),
    enabled: config.jmDownload,
    maxChapters: config.jmMaxChapters,
    maxPages: config.jmMaxPages,
    timeoutMs: config.jmTimeoutMs,
    requestTimeoutMs: config.jmRequestTimeoutMs,
    maxFiles: config.jmMaxFiles,
    maxJobs: config.jmMaxJobs,
    fileHost: config.jmFileHost,
    filePort: config.jmFilePort,
    urlTtlMs: config.jmUrlTtlMs,
    report,
  });

  /**
   * 取出（或创建）某个 QQ 会话所对应的 Agent。
   *
   * 查找顺序：先看 Harness 里该 session id 是否已活着（热路径，直接复用）；
   * 否则先 resume 已持久化的会话，resume 失败（首次对话）再 create 新建。
   * @param conversation - 要绑定的会话记录。
   * @returns 存活的 Agent。
   */
  async function ensureAgent(conversation) {
    const sessionId = sessionIdFor(conversation.key);
    const live = ctx.agents.get(sessionId);
    if (live !== undefined) {
      conversation.agent = live;
      // 句柄只在「还是同一个 Agent」时保留：换了 Agent 对象说明旧句柄已经失效。
      if (conversation.handle?.agent !== live) conversation.handle = undefined;
      sessionIndex.set(live.id, conversation.key);
      return live;
    }
    // 群名只影响提示词和会话列表的可读性，查询失败绝不能挡住回复链路。
    if (conversation.type === 'group' && conversation.name.length === 0) {
      conversation.name = await client
        .call('get_group_info', { group_id: Number(conversation.id) })
        .then((info) => String(info?.group_name ?? ''))
        .catch(() => '');
    }
    // 组装 agentOptions：只带上真正有值的字段，避免把空串当成显式选择。
    const chosen = resolveRoute();
    const agentOptions = {};
    if (chosen.provider.length > 0) agentOptions.provider = chosen.provider;
    if (chosen.model.length > 0) agentOptions.model = chosen.model;
    if (chosen.reasoningEffort !== undefined) agentOptions.reasoningEffort = chosen.reasoningEffort;
    if (chosen.model.length === 0) {
      throw new Error(`qq-bridge: no model for QQ sessions (${chosen.error}); set provider/model on the plugin`);
    }
    // Agent 预设：Web 表面（`dsh-web-app`）把 bash / fs / web_search 这些「agent 平面」
    // 的工具从宿主搬进了每个 Agent 预设，程序化创建的 Agent 必须先 join 一个预设，
    // 这些工具才会成为它继承来的工具。预设 id 在 create 之前解析，好让 meta 一并记录。
    const presetId = await resolveAgentPreset();
    // 部署 persona 会用 `agent.options` 里的值替换 `{{model}}`；这里再在 Agent 自己的
    // 作用域里覆盖一次，让「早于本次模型选择就存在」的 resume 会话也能正常渲染提示词，
    // 而不会让整个 turn 失败。同时把 QQ 渠道说明作为独立小节注入系统提示。
    const setup = async (agentCtx, agent) => {
      // 顺序不能反：先 join 预设（工具此刻才存在），再按白名单收窄，最后装配提示词
      // —— 提示词里提到的工具必须确实是这个 Agent 能看见的。
      await mountAgentPreset(agentCtx, agent, presetId);
      restrictAgentTools(agentCtx, agent);
      const prompt = agentCtx.get?.('systemPrompt');
      if (prompt === undefined) return;
      prompt.variable('model', () => agentOptions.model);
      prompt.variable('provider', () => agentOptions.provider);
      prompt.section({
        name: 'qq-bridge:channel',
        order: CHANNEL_SECTION_ORDER,
        interpolate: false,
        // 传函数而不是字符串：`SystemPrompt.section()` 会在每次装配时重新求值，
        // 群聊里换了发言者 / 群里又聊了几句都能立刻反映到提示词里。
        text: () => channelPrompt(conversation),
      });
    };
    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      report('info', `resumed ${sessionId} for ${conversation.key}`);
    } catch {
      handle = await ctx.agents.create({
        sessionId,
        meta: presetId.length > 0 ? { cwd, agentPreset: presetId } : { cwd },
        agentOptions,
        setup,
      });
      report('info', `created ${sessionId} for ${conversation.key}`);
    }
    conversation.agent = handle.agent;
    // 保留句柄：/reset 需要用它销毁这个 Agent（连同它的 Session 与写出句柄）。
    conversation.handle = handle;
    sessionIndex.set(handle.agent.id, conversation.key);
    // 无人值守的 QQ 会话默认一律拒绝需要审批的操作（工具会直接报「被拒绝」），
    // 避免群里的人通过机器人指挥它执行危险命令。
    if (approvalPolicy === 'never') {
      const approval = ctx.get('approval');
      try {
        approval?.setPolicy(handle.agent, 'never');
      } catch (error) {
        report('warn', `could not set approval policy: ${error?.message ?? error}`);
      }
    }
    return handle.agent;
  }

  /**
   * 解析 QQ 会话应当挂载的 Agent 预设 id。
   *
   * Web 表面（`dsh-web-app`）把 bash / fs / read / web_search 这些「agent 平面」的行
   * 从宿主搬进了每个 Agent 预设：宿主上不再有这些工具，程序化创建的 Agent 必须先
   * join 一个预设，它们才会出现在这个 Agent 继承来的工具里。不 join 预设的 Agent
   * 只有宿主平面注册的全局工具（本插件的 `qq_*`），于是 `allowTools` 里的
   * read / web_search 全部是「不存在的工具名」——白名单收窄得再准也给不出不存在的能力。
   *
   * 解析结果为 '' 表示不挂载：要么配置成 `none`，要么这个组合根本没有预设平面
   * （例如从 `dsh-base` 起的 headless 部署，工具本来就在宿主上）。
   * @returns 预设 id；不需要/无法挂载时为空串。
   */
  async function resolveAgentPreset() {
    const wanted = config.agentPreset.trim();
    if (wanted.toLowerCase() === PRESET_NONE) return '';
    const presets = ctx.get('agentPresets');
    // 没有预设平面：工具仍按老样子在宿主上，照常走白名单收窄即可。
    if (presets === undefined) return '';
    try {
      return (await presets.resolve(wanted.length > 0 ? wanted : undefined)).id;
    } catch (error) {
      // 配错预设名不能打死回复链路；但没有预设就没有 agent 平面的工具，白名单会
      // 退化成「只有 qq_*」，所以这条 warn 必须带上原因。
      report('warn', `could not resolve agent preset "${wanted.length > 0 ? wanted : '(default)'}": ${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 把某个 Agent join 到预设修订上（`agentPresets.mount()`）。
   *
   * 必须在 setup 里、用 Agent 自己的 ctx 调用：join 会把 Agent 作用域的父节点绑到
   * 预设的 standing key 上，预设里的工具随之成为 Agent **继承**来的工具，
   * `tools.restrict()` 才可能按白名单收窄它们。
   * @param agentCtx - Agent 自己的作用域上下文（setup 的第一个参数）。
   * @param agent - 刚创建/恢复的 Agent（仅用于日志）。
   * @param presetId - 已解析的预设 id；空串表示不挂载。
   */
  async function mountAgentPreset(agentCtx, agent, presetId) {
    if (presetId.length === 0) return;
    const presets = ctx.get('agentPresets');
    if (presets === undefined) return;
    try {
      await presets.mount(agentCtx, presetId);
      report('info', `${agent?.id ?? 'agent'} joined agent preset ${presetId}`);
    } catch (error) {
      report('warn', `could not mount agent preset ${presetId} on ${agent?.id ?? 'agent'}: ${error?.message ?? error}`);
    }
  }

  /**
   * 把配置里的工具白名单施加到某个 QQ 会话 Agent 自己的作用域上。
   *
   * `tools.restrict()` 只收窄「调用它的那个作用域」所继承的工具，所以必须用 Agent
   * 自己的 ctx 调用：它过滤掉继承来的全局/预设工具，而该作用域内注册的工具不受影响
   * （这也是 DSH 子代理 toolFilter 的同一套机制）。白名单为空 = 不限制。
   *
   * 前提是 Agent 已经 join 了预设（见 mountAgentPreset）：只放开**继承得到**的工具名，
   * 收窄得再准也变不出这个 Agent 组合里根本没有的能力。
   *
   * 名字写错时 `restrict()` 会直接抛错（它拒绝一切未知的工具名）。为了不让一个
   * 拼写错误打死整条 QQ 回复链路，这里退化成「当前真正看得见的那部分」：写错的名字
   * 丢掉并告警；一个都不剩时等于把工具全部收走 —— 使用者明确要的是白名单，所以
   * 宁可无工具（fail-closed），也不能悄悄退回全量工具。
   * @param agentCtx - Agent 自己的作用域上下文（其中的 tools 服务是作用域绑定的）。
   * @param agent - 刚创建/恢复的 Agent，同时作为 restrict/get 的视角 scope。
   */
  function restrictAgentTools(agentCtx, agent) {
    if (allowTools.length === 0) return;
    const tools = agentCtx?.tools;
    if (tools === undefined) {
      // 没有作用域绑定就没法收窄（全局 restrict 会遮蔽所有 Agent，被 DSH 明确拒绝）。
      report('warn', 'allowTools is configured but the Agent scope exposes no tools service; tools stay unrestricted');
      return;
    }
    try {
      tools.restrict({ allow: allowTools });
      report('info', `${agent?.id ?? 'agent'} limited to tools: ${allowTools.join(', ')}`);
      return;
    } catch (error) {
      const visible = allowTools.filter((name) => tools.get(name, agent) !== undefined);
      report('warn',
        `allowTools rejected (${error?.message ?? error}); keeping only the visible names: ${visible.join(', ') || '(none)'}` +
          // 这句是给「QQ 会话突然没有联网/读文件能力」准备的诊断线索：白名单只能收窄
          // 这个 Agent 组合里已有的工具，给不出它没有的能力。
          (visible.length < allowTools.length
            ? ' — a whitelist cannot grant tools this Agent does not have; check the agent preset mount (config agentPreset)'
            : ''),
      );
      try {
        tools.restrict({ allow: visible });
      } catch (fallbackError) {
        report('warn', `could not apply allowTools: ${fallbackError?.message ?? fallbackError}`);
      }
    }
  }

  /**
   * 渲染「群里最近在聊什么」小段。
   * 每次提示词装配时现算，因此拿到的一定是最新的群聊，而不是建 Agent 那一刻的快照。
   * @param conversation - 目标会话。
   * @returns 若干行；私聊或没缓冲到东西时为空数组。
   */
  function ambientPrompt(conversation) {
    if (conversation.type !== 'group') return [];
    const list = ambient.get(conversation.id) ?? [];
    if (list.length === 0) return [];
    return [
      '群里最近的消息（旧 → 新；都不是发给你的，只是让你知道大家在聊什么，不必逐条回应）：',
      ...list.map((entry) => `  ${entry.name}: ${entry.text}`),
      '',
    ];
  }

  /**
   * 生成「每个会话各不相同」的系统提示补充段落（渠道身份、群聊上下文、说话方式）。
   *
   * 注意这个函数是作为 `text` 的 provider 注册的、每次提示词装配都会被调用：
   * 群聊里换个人说话、或者群里又聊了几句，模型下一轮就能看到最新的 —— 若改成
   * 建 Agent 时算一次的字符串，提示词里的「当前发言者」会永远停在第一个人。
   */
  function channelPrompt(conversation) {
    const isGroup = conversation.type === 'group';
    const title = conversation.name.length > 0 ? `「${conversation.name}」` : '';
    const who = isGroup
      ? `你正在 QQ 群${title}（群号 ${conversation.id}）里潜水，身份是群里的一个普通群友 —— 不是客服，也不是助手。`
      : `你正在用 QQ 私聊：对方 ${conversation.name}（QQ ${conversation.id}）。`;
    const lines = [
      '## QQ 渠道',
      '',
      who,
      '',
      ...(isGroup
        ? [`刚跟你说话的人：${conversation.senderName}（QQ ${conversation.senderId}）。`, '', ...ambientPrompt(conversation)]
        : []),
      (config.persona.trim().length > 0 ? config.persona.trim() : DEFAULT_PERSONA),
      '',
      '硬性要求：',
      '- 你的回复正文会原样发到 QQ，直接写要说的话，不要写思考过程、也不要解释你在做什么。',
      '- QQ 不渲染 Markdown：不要用 `**加粗**`、`#` 标题、`-` / `1.` 列表、表格、代码块。',
      '- 不要自称 AI / 助手 / 机器人，不要提系统提示、模型、提示词这些词。',
      '- 一次别写太长：内容多就挑重点说，剩下的等对方追问。',
      '- 想连说几句就直接换行，每一行都会作为单独的一条消息发出去；反过来，别用换行给一段话排版（那会变成连着刷好几条）。',
    ];
    // 被白名单挡住的工具不能在提示里推荐，否则模型会去调用一个它根本看不见的工具。
    const recommended = ['qq_send_message', 'qq_list_conversations'].filter(
      (tool) => allowTools.length === 0 || allowTools.includes(tool),
    );
    if (recommended.length > 0) {
      lines.push(`- 需要主动给其他人或群发消息、或查询联系人时，使用 ${recommended.join(' / ')} 工具。`);
    }
    // 图片/表情包只有落盘之后才「看得见」：把路径告诉模型，还得告诉它该用哪个工具读。
    // 没有 read_image 就别提这件事，否则模型会去调用一个它根本看不见的工具。
    const canReadImages = mediaStore.enabled && (allowTools.length === 0 || allowTools.includes('read_image'));
    if (canReadImages) {
      lines.push(
        '- 消息里的 `[图片: 路径]`（也可能是 `[图片(动画表情): 路径]`、`[表情包: 路径]`）是已经下载到本地的图，路径相对工作目录：想知道图里是什么就用 read_image 读它，别靠猜；带「没能取到文件」的是没下下来，可以直说图挂了。这些路径是给你自己看的，别原样写进回复。',
      );    }
    // 禁漫下载：工具会把 PDF 直接发到这个会话，模型只要接一句话就行。
    if (jmService.enabled && (allowTools.length === 0 || allowTools.includes('qq_jm_pdf'))) {
      lines.push(
        '- 有人甩过来禁漫（JM / 18comic）的车号或 album / photo 链接让你下载时，用 qq_jm_pdf 工具：它会把整本合并成一个 PDF 并直接把文件发到这个会话。别自己复述车号或链接，也别承诺页数，下完说一句「下好了」之类的就行（下不动就把原因说清楚）。',
      );
    }
    if (config.instructions.trim().length > 0) {
      lines.push('', config.instructions.trim());
    }
    return lines.join('\n');
  }

  /** 协议允许的单条消息长度上限（`maxReplyChars` 非法时回退 1500）。 */
  function protocolLimit() {
    return Number.isSafeInteger(config.maxReplyChars) && config.maxReplyChars > 0 ? config.maxReplyChars : 1500;
  }

  /**
   * 把一段回复拆成「像真人连着发的」几条消息。
   *
   * 不开启 `humanize` 时就是旧行为（只在超过协议上限时分段）。开启后先把换行拆成
   * 一条条独立消息（换行 = 分条，不再是同一条里的排版），再对每一行按标点/长度拆成
   * 短句（受 `burstMaxChars` / `burstMaxParts` 约束），最后每段都接受一次协议上限的
   * 硬校验 —— 模型偶尔写超长时，最后一段仍可能被 `chunkText` 再切开。
   * @param text - 模型给出的完整回复。
   * @returns 按发送顺序排列的分段。
   */
  function burstParts(text) {
    const limit = protocolLimit();
    if (!config.humanize) return chunkText(text, limit);
    const burst = Number.isSafeInteger(config.burstMaxChars) && config.burstMaxChars > 0
      ? Math.min(config.burstMaxChars, limit)
      : limit;
    const maxParts = Number.isFinite(config.burstMaxParts) ? Math.max(1, Math.floor(config.burstMaxParts)) : 3;
    return splitBurst(text, burst, maxParts).flatMap((part) => chunkText(part, limit));
  }

  /** 发送前等待（`ms <= 0` 时立即返回）；unref 让待发的延迟不拖住进程退出。 */
  function sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * 把一条回复发到 QQ：拆段、按真人打字节奏加延迟，任一段失败即停止。
   *
   * 同一个会话的发送挂在 `conversation.sending` 上串行执行：拟人延迟会让一次回复
   * 持续好几秒，若不排队，下一轮回复会插进来，群里看到的就是两条消息交错。
   *
   * @param conversation - 目标会话。
   * @param text - 要发送的正文。
   * @param options - `human`：拆短句 + 打字延迟（自动回复用）；`quote`：本轮的回复指向
   *   `{ messageId, userId, seq }`，仅群聊生效，且只挂在第一条上。
   * @returns 本次发送（含延迟）完成时兑现的 Promise，绝不 reject。
   */
  function sendToConversation(conversation, text, { human = false, quote } = {}) {
    const run = () => sendParts(conversation, text, human, quote ?? { messageId: '', userId: '', seq: 0 });
    // 前一次发送失败也要继续排下一次，所以两个分支都接上 run。
    const chained = (conversation.sending ?? Promise.resolve()).then(run, run);
    conversation.sending = chained.then(
      () => {},
      () => {},
    );
    return chained;
  }

  /** `sendToConversation` 的实际发送步骤（调用方已保证同一会话串行）。 */
  async function sendParts(conversation, text, human, quote) {
    const parts = human ? burstParts(text) : chunkText(text, protocolLimit());
    for (const [index, part] of parts.entries()) {
      if (human) {
        // 第一条前多等一个「读消息」的时间；后续每条只算打字时间。
        // 字段逐个显式传：`delayJitter` 与纯函数的 `jitter` 不同名，整包展开会静默丢掉抖动。
        await sleep(typingDelayMs(part.length, {
          charsPerSecond: config.charsPerSecond,
          minDelayMs: config.minDelayMs,
          maxDelayMs: config.maxDelayMs,
          jitter: config.delayJitter,
          baseMs: index === 0 ? config.readDelayMs : 0,
        }));
      }
      // 群聊与私聊走不同的 OneBot action，参数名也不同。
      const action = conversation.type === 'group' ? 'send_group_msg' : 'send_private_msg';
      const idKey = conversation.type === 'group' ? 'group_id' : 'user_id';
      try {
        await client.call(action, { [idKey]: conversation.id, message: quoteSegments(conversation, part, index, quote) });
      } catch (error) {
        report('warn', `could not send to ${conversation.key}: ${error?.message ?? error}`);
        return;
      }
    }
  }

  /**
   * 组装一条消息的 `message` 字段。
   *
   * 只有群聊的**第一条**才带指向：真人不会每条都 @ 一遍，引用刷屏也很烦。
   * 其余情况仍返回纯字符串 —— 与旧版发送格式完全一致，也少一个出错点。
   * @param conversation - 目标会话。
   * @param part - 本条正文。
   * @param index - 在本轮分段里的序号（0 = 第一条）。
   * @param quote - 被回复消息的 `{ messageId, userId, seq }`。
   * @returns 纯文本字符串，或 OneBot 消息段数组。
   */
  function quoteSegments(conversation, part, index, quote) {
    if (index !== 0 || conversation.type !== 'group') return part;
    const style = config.replyStyle;
    let head;
    if (style === 'auto') {
      // 只在「我回的那条后面又有人说话」时才引用。紧挨着回时引用是纯噪音：一轮问答
      // 本来就看得出来在回谁，每条都挂个引用块反而像机器人在逐条点着回复。
      // 中间隔了别人的话才需要点名，不然接不上话头。
      const drifted = typeof quote.seq === 'number' && (chatterSeq.get(conversation.id) ?? 0) > quote.seq;
      if (!drifted || quote.messageId.length === 0) return part;
      head = { type: 'reply', data: { id: quote.messageId } };
    } else if (style === 'quote' && quote.messageId.length > 0) head = { type: 'reply', data: { id: quote.messageId } };
    else if (style === 'at' && quote.userId.length > 0) head = { type: 'at', data: { qq: quote.userId } };
    else return part;
    return [head, { type: 'text', data: { text: part } }];
  }

  // ---- 禁漫（JM）下载 → PDF → 发到 QQ ----------------------------------------
  // `/jm <车号|链接>` 指令与 `qq_jm_pdf` 工具走的是同一条链路：下载（jm.js 里的
  // python 子进程）→ 拿一次性 URL 交给 NapCat 上传。区别只在于「谁点的」和
  // 「要不要先回一句」。

  /**
   * 指令匹配器：`jmCommand` 里的斜杠可有可无（群聊 `groupTrigger: prefix` 会把
   * 开头的 `/` 当触发前缀吃掉，两种写法都得认识）。
   */
  const jmCommandPattern = (() => {
    const command = config.jmCommand.trim();
    if (command.length === 0) return undefined;
    const bare = command.replace(/^\/+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/?${bare}(?:\\s+|$)`, 'i');
  })();

  /**
   * 读一条「直接下载」指令。
   * @param text - 已 trim 的正文。
   * @returns `{ rest }`（命中指令，`rest` 是指令后面的参数）或 `{ rest, ref }`；没命中时 undefined。
   */
  function readJmCommand(text) {
    if (jmCommandPattern === undefined) return undefined;
    const match = jmCommandPattern.exec(text);
    if (match === null) return undefined;
    const rest = text.slice(match[0].length).trim();
    return { rest, ref: rest.length > 0 ? parseJmRef(rest) : undefined };
  }

  /** 把 `meta` 事件渲染成一句人话（标题 / 话数 / 页数）。 */
  function describeJm(meta) {
    const title = typeof meta?.title === 'string' && meta.title.length > 0 ? `《${meta.title}》` : `jm${meta?.id ?? ''}`;
    const extra = [];
    if (Number(meta?.chapters) > 1) extra.push(`${meta.chapters} 话`);
    if (Number(meta?.pages) > 0) extra.push(`${meta.pages} 页`);
    return extra.length > 0 ? `${title}（${extra.join(' · ')}）` : title;
  }

  /**
   * 取一个可用的发送目标：已经有会话记录就复用（发送串行链也一起复用），
   * 否则给一个一次性的壳 —— 出站工具可能指向一个从没聊过的群/好友。
   */
  function targetConversation(type, id) {
    const key = `${type}:${id}`;
    const existing = conversations.get(key);
    if (existing !== undefined) return existing;
    return { key, type, id: String(id), name: '', senderId: '', senderName: '', agent: undefined, handle: undefined, queue: Promise.resolve(), sending: Promise.resolve() };
  }

  /**
   * 把 PDF 交给 NapCat 发到 QQ。
   *
   * NapCat 在容器里、插件在宿主机上，只能给它一个 URL 让它自己来拉（传本地路径会
   * 回 `识别URL失败`，因为容器里根本没有那个文件）。群文件还要机器人有上传权限，
   * 失败时如实把原因带回去，由调用方决定怎么措辞。
   * @returns `{ ok: true }` 或 `{ ok: false, error }`。
   */
  async function sendJmFile(conversation, job) {
    let url;
    try {
      url = await jmService.serve(job.path, job.name);
    } catch (error) {
      return { ok: false, error: `file server: ${errorText(error)}` };
    }
    const group = conversation.type === 'group';
    const action = group ? 'upload_group_file' : 'upload_private_file';
    // 群文件接口允许带 folder；NapCat 接受空串，显式给一个免得别的实现报缺参。
    const params = group
      ? { group_id: conversation.id, file: url, name: job.name, folder: '' }
      : { user_id: conversation.id, file: url, name: job.name };
    try {
      await client.call(action, params, config.jmUploadTimeoutMs);
      report('info', `jm: uploaded ${job.name} (${job.bytes} bytes) to ${conversation.key}`);
      return { ok: true };
    } catch (error) {
      const reason = errorText(error);
      report('warn', `jm: ${action} to ${conversation.key} failed: ${reason}`);
      return { ok: false, error: reason };
    }
  }

  /**
   * 跑一次「下载 + 发送」。下载本身在 jm.js 里（python 子进程 + 并发键）。
   * @param options.conversation - 目标会话。
   * @param options.ref - `{ id, kind }`。
   * @param options.onMeta - 拿到元信息时回调（进度提示用）。
   * @returns 下载结果（含 `path` / `name` / `pages` / `bytes` / `title`）。
   */
  async function downloadJm({ conversation, ref, onMeta }) {
    if (!jmService.enabled) {
      throw new Error('禁漫下载没启用（检查 jmDownload / jmDir / jmPython / jmScript）');
    }
    if (jmService.isRunning(conversation.key)) {
      const busy = new Error('这个会话已经有一个下载在跑了');
      busy.code = 'JM_BUSY';
      throw busy;
    }
    return jmService.run({ id: ref.id, kind: ref.kind, key: conversation.key, onMeta });
  }

  /**
   * `/jm <车号>` 的完整直线：先回一句「收到」，拿到元信息再回一句「找到了」，
   * 下完把 PDF 发上去。全程不进 Agent —— 车号是明确的任务，没必要让模型参与。
   * 任何失败都变成一句人话回给 QQ（这条链路是无人值守的）。
   */
  async function runJmCommand(conversation, ref, quote) {
    if (!jmService.enabled) {
      await sendToConversation(conversation, '（禁漫下载没开：jmDownload 关了，或者 jmDir / jmPython 配得不对）', { quote });
      return;
    }
    if (jmService.isRunning(conversation.key)) {
      await sendToConversation(conversation, '（还在下上一本，等下）', { quote });
      return;
    }
    await sendToConversation(conversation, `收到，去下 jm${ref.id} 了…`, { quote });
    try {
      const job = await downloadJm({
        conversation,
        ref,
        // 元信息一到就先报一句：整本可能下十几分钟，不能让群里干等。
        onMeta: (meta) => {
          void sendToConversation(conversation, `找到了：${describeJm(meta)}，下完直接发文件`);
        },
      });
      const sent = await sendJmFile(conversation, job);
      if (sent.ok) await sendToConversation(conversation, `下好了：${describeJm({ id: ref.id, title: job.title, chapters: job.chapters, pages: job.pages })}`);
      else await sendToConversation(conversation, `下好了，但文件发不出去：${sent.error}`);
    } catch (error) {
      if (error?.code === 'JM_BUSY') {
        await sendToConversation(conversation, '（还在下上一本，等下）');
        return;
      }
      await sendToConversation(conversation, `没下成：${errorText(error)}`);
    }
  }

  /**
   * 找出并删除某个 Session 在磁盘上的持久化记录。
   *
   * 位置来自 sessionPersistence 服务自己解析出的 `root`（jsonl 后端把 root 作为
   * 公开字段暴露出来），布局是 `<root>/<项目目录>/<会话 id>/`；这里按「项目目录」
   * 通配一层，而不是自己重算项目目录的编码规则，避免和宿主的命名逻辑绑死。
   * 只用服务给出的这一个根目录：多扫一个候选根目录意味着可能碰到不属于本进程的
   * 数据（测试里就出现过「按真实 ~/.dsh 路径删掉线上会话」的危险），所以拿不到
   * `root` 时才退回 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。
   * @param sessionId - 要清除的 Session id。
   * @returns 实际删掉的会话目录数（0 表示磁盘上本来就没有）。
   */
  async function deleteStoredSession(sessionId) {
    const service = ctx.get('sessionPersistence');
    const envHome = process.env.DSH_HOME?.trim();
    const fallback = join(envHome && envHome.length > 0 ? envHome : join(homedir(), '.dsh'), 'sessions');
    const root = typeof service?.root === 'string' && service.root.length > 0 ? service.root : fallback;
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return 0; // 根目录不存在（或没有权限）：磁盘上就是没有记录。
    }
    let removed = 0;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name, sessionId);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue; // 这个项目目录下没有该会话。
      }
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
        report('info', `removed stored session at ${dir}`);
      } catch (error) {
        report('warn', `could not remove ${dir}: ${error?.message ?? error}`);
      }
    }
    return removed;
  }

  /**
   * 清空一个 QQ 会话的记忆：`/reset` 的实际动作。
   *
   * 两步缺一不可 —— 先销毁活着的 Agent（内存里的对话历史、以及它持有的 Session
   * 写出句柄都随之释放），再删掉磁盘上的会话记录。只做前者，下一条消息会 resume
   * 出旧记录；只做后者，活着的 Agent 会把文件写回来且记忆仍在。
   * @param conversation - 要重置的会话记录。
   * @returns 是否成功清空（false 表示磁盘记录还在，调用方据此回复）。
   */
  async function resetConversation(conversation) {
    const sessionId = sessionIdFor(conversation.key);
    // 1) 销毁 Agent（handle.dispose() 是幂等的）。
    const live = conversation.agent ?? ctx.agents.get(sessionId);
    if (live !== undefined) {
      try {
        if (conversation.handle?.agent === live) await conversation.handle.dispose();
        // HMR/配置热重载后句柄可能丢了，退回 Agent 自己的作用域销毁（ReAct 循环把
        // scope 挂在 Agent 上）。
        else if (typeof live.scope?.dispose === 'function') await live.scope.dispose();
        else throw new Error('no disposer available for the live agent');
      } catch (error) {
        // 销毁失败就必须保留磁盘记录：半清状态下记忆会以更隐蔽的方式回来。
        report('warn', `could not dispose ${sessionId}: ${error?.message ?? error}`);
        return false;
      }
    }
    // 2) 删掉磁盘记录，让下一条消息 resume 失败、走 create 新建空会话。
    const removed = await deleteStoredSession(sessionId);
    // 3) 清掉插件自己的记账，避免旧会话的 turn 结果串到新会话上。
    conversation.agent = undefined;
    conversation.handle = undefined;
    sessionIndex.delete(sessionId);
    for (const [slot, owner] of turnOwners) {
      if (owner?.key === conversation.key || slot.startsWith(`${sessionId}:`)) turnOwners.delete(slot);
    }
    for (const [slot, owner] of submitted) {
      if (owner?.key === conversation.key) submitted.delete(slot);
    }
    for (const slot of [...transcripts.keys()]) {
      if (slot.startsWith(`${sessionId}:`)) transcripts.delete(slot);
    }
    // 群聊上下文也算「刚才那些话」，一起忘掉；否则重置后模型还知道群里之前聊了什么。
    if (conversation.type === 'group') ambient.delete(conversation.id);
    report('info', `reset ${conversation.key} (${sessionId}), removed ${removed} stored log(s)`);
    return true;
  }

  /** 取出（或新建）一条入站消息所属的会话记录，并刷新发送者信息。 */
  function conversationFor(type, id, sender) {
    const key = `${type}:${id}`;
    let conversation = conversations.get(key);
    if (conversation === undefined) {
      // queue 是一条串行链：同一个会话的消息按到达顺序依次处理，避免并发 turn。
      // handle 是 Harness 给出的 Agent 句柄，/reset 靠它销毁 Agent。
      conversation = {
        key,
        type,
        id: String(id),
        name: '',
        senderId: '',
        senderName: '',
        agent: undefined,
        handle: undefined,
        queue: Promise.resolve(),
        // 出站串行链：拟人延迟会让一次回复持续若干秒，这期间的后续回复必须排队，
        // 否则群里会看到两条消息交错着冒出来。
        sending: Promise.resolve(),
      };
      conversations.set(key, conversation);
    }
    if (type === 'group') {
      // 群名只有 get_group_info 才知道，入站事件里没有：只在拿到非空值时覆盖，
      // 否则第二条消息就会把已查到的群名冲成空串。
      const groupName = String(sender?.groupName ?? '');
      if (groupName.length > 0) conversation.name = groupName;
      conversation.senderId = String(sender?.userId ?? '');
      conversation.senderName = String(sender?.userName ?? '');
    } else {
      conversation.name = String(sender?.userName ?? '');
      conversation.senderId = String(sender?.userId ?? '');
      conversation.senderName = conversation.name;
    }
    return conversation;
  }

  /**
   * prefix 触发时，把开头的指令前缀从正文里去掉。
   * 入站时先在占位文本上判定一次（决定这条消息要不要理），媒体落盘后再对真正的
   * 正文调用一次（那才是发给模型的内容）—— 两处用的是同一个函数。
   * @param text - 已 trim 的正文。
   * @returns 去掉前缀后的正文。
   */
  function dropPrefix(text) {
    return config.groupTrigger === 'prefix' ? text.slice(config.prefix.length).trim() : text;
  }

  /**
   * 准入判断：这条入站消息该不该送到它的 Agent。
   *
   * 只做**同步**判定（渠道开关、白名单、@/前缀触发、正文非空），绝不碰网络：媒体落盘
   * 发生在 `handleEvent` 把它排进会话队列之后。返回的 `message` 是原始消息段数组，
   * 真正的正文由调用方在媒体落盘后用 `messageToText(message, selfId, media)` 再渲染一次。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns `{ conversation, message, quote }`；该丢弃时为 undefined。
   */
  function admit(event, selfId) {
    if (event?.post_type !== 'message') return undefined;
    // 机器人自己发的消息会以 message 事件回灌，必须排除；selfId 未就绪时也一律不处理。
    if (String(event.user_id ?? '') === String(selfId) || selfId === '') return undefined;
    const message = event.message ?? event.raw_message;
    const isGroup = event.message_type === 'group';
    const sender = event.sender ?? {};
    if (isGroup) {
      if (!config.groupChat) return undefined;
      const groupId = String(event.group_id);
      if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return undefined;
      const at = mentions(message, selfId);
      if (config.groupTrigger === 'mention' && !at) return undefined;
      if (config.groupTrigger === 'prefix' && !messageToText(message).trimStart().startsWith(config.prefix)) return undefined;
      // 这里只用**占位符**版本判定「这条消息有没有内容」：媒体下载是异步的，此刻还没
      // 落盘，而 `[图片]` 这样的占位符已经足够说明「他发了点东西」。真正的正文在
      // handleEvent 里等媒体落盘后再渲染一次。
      // 传入 selfId 是为了按 account 精确剔除 @机器人 段，而不是事后从扁平文本里砍掉
      // 开头的 `@…` —— 这样 `@bot你好` 才能完整保留成 `你好`（昵称含空格也不会被误删）。
      const preview = dropPrefix(messageToText(message, selfId).trim());
      if (preview.length === 0) return undefined;
      return {
        conversation: conversationFor('group', groupId, {
          groupName: '',
          userId: event.user_id,
          userName: sender.card ?? sender.nickname ?? String(event.user_id),
        }),
        message,
        // 回复指向：引用被回复的那条消息（`reply` 段要 message_id），或 @ 回提问者（要 QQ 号）。
        // `seq` 是这条消息在群里的进度，供 `auto` 判断「等我回话时有没有人插话」。三样都
        // 在这里一次性快照：发送在几秒后，那时会话记录和群里的进度都可能已经变了。
        quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: chatterSeq.get(groupId) ?? 0 },
      };
    }
    if (!config.privateChat) return undefined;
    const userId = String(event.user_id);
    if (config.allowUsers.length > 0 && !config.allowUsers.includes(userId)) return undefined;
    if (messageToText(message, selfId).trim().length === 0) return undefined;
    return {
      conversation: conversationFor('private', userId, {
        userId,
        userName: sender.nickname ?? sender.card ?? userId,
      }),
      message,
      // 私聊始终是 plain，`seq` 只是让 quote 的字段形状保持一致。
      quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: 0 },
    };
  }

  /**
   * 记一次「群里又有人说话了」，返回该群当前的进度序号。
   *
   * 每条**别人的**群消息都算（被 @ 的和没被 @ 的都算）：`auto` 回复指向靠入站与
   * 发送两个时刻的序号差判断该不该引用。机器人自己发的消息会作为 message 事件回灌，
   * 那是我自己的话、不是「有人插话」，所以按 selfId 剔除。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 该群在计入这条消息之后的序号。
   */
  function noteChatter(event, selfId) {
    if (event?.message_type !== 'group') return 0;
    if (String(event.user_id ?? '') === String(selfId)) return 0;
    const groupId = String(event.group_id);
    const next = (chatterSeq.get(groupId) ?? 0) + 1;
    chatterSeq.set(groupId, next);
    // 兜底：见过面的群不该这么多；真超了就丢掉最早的那个群，它接下来的回复退化成 plain。
    if (chatterSeq.size > 512) {
      const oldest = chatterSeq.keys().next().value;
      if (oldest !== undefined && oldest !== groupId) chatterSeq.delete(oldest);
    }
    return next;
  }

  /**
   * 把一条「不是发给机器人」的群消息记进环境缓冲。
   *
   * 只有被 admit 丢掉的消息才会走到这里：被 @ 的那条会作为 user message 进入会话，
   * 再在环境里重复一遍反而会让模型以为对方说了两次。于是模型看到的是
   * 「群里刚才在聊这些」+「现在有人 @ 我说了这句」，和真人的感知顺序一致。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号（机器人自己的消息不进缓冲）。
   */
  function rememberAmbient(event, selfId) {
    const limit = Math.floor(Number(config.ambientMessages) || 0);
    if (limit <= 0) return;
    if (!config.groupChat || event?.message_type !== 'group') return;
    if (String(event.user_id ?? '') === String(selfId)) return;
    const groupId = String(event.group_id);
    if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return;
    // 折掉换行：多行消息会破坏「昵称: 内容」一行一条的版式。
    // 这里刻意**不**落盘媒体：环境上下文的意义只是「知道大家在聊什么」，没人会去读
    // 闲聊里刷的表情包，为它们花带宽和磁盘不值 —— 只有被 @ 的那条才下载。
    const text = messageToText(event.message ?? event.raw_message).replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;
    const sender = event.sender ?? {};
    const name = String(sender.card ?? sender.nickname ?? event.user_id ?? '某人');
    const lineChars = Math.max(1, Math.floor(Number(config.ambientLineChars) || 120));
    const list = ambient.get(groupId) ?? [];
    list.push({ name, text: text.slice(0, lineChars) });
    while (list.length > limit) list.shift();
    ambient.set(groupId, list);
  }

  /**
   * 把一条消息里的图片/表情包落到本地，并给出「段下标 → 替身文本」的映射。
   *
   * 只对**发给机器人的**那条消息做这件事：群聊环境上下文里的图（别人闲聊时刷的表情包）
   * 不会有人去读，为它们下载只是白白消耗带宽和磁盘。同一张图被反复发也没关系 ——
   * 缓存按内容哈希命名，命中的是同一个文件。
   *
   * @param message - OneBot 的 `message` 字段。
   * @returns 映射；这条消息里没有媒体段、或下载功能被关掉时返回 undefined。
   */
  async function resolveMessageMedia(message) {
    if (!mediaStore.enabled) return undefined;
    const items = collectMedia(message);
    if (items.length === 0) return undefined;
    const rendered = new Map();
    // 并行取：一条消息里同时发几张图很常见，串行会一条条排队。
    await Promise.all(
      items.map(async (item) => {
        const outcome = await mediaStore.resolve(item);
        if (outcome.path !== undefined) {
          report('info', `media: ${item.kind}${item.label.length > 0 ? ` "${item.label}"` : ''} → ${outcome.path} (${outcome.bytes} bytes)`);
          rendered.set(item.index, mediaPlaceholder(item, outcome.path));
          return;
        }
        // 取不到不是错误路径上的意外：消息照常投递，只是模型看到的是一句「这里本来有张图」。
        report('warn', `media: could not fetch ${item.kind}${item.label.length > 0 ? ` "${item.label}"` : ''}: ${outcome.error}`);
        rendered.set(item.index, mediaPlaceholder(item, '', outcome.error));
      }),
    );
    return rendered;
  }

  /** 处理一条已解码的 OneBot 事件（由 OneBotClient 的 onEvent 调用）。 */
  function handleEvent(event) {
    const selfId = client.selfId;
    if (event?.post_type !== 'message') return;
    if (selfId === '') return;
    // 先记「群里又有人说了一句」，`admit` 紧接着快照的序号才算上这条自己 ——
    // 快照与发送时读到的值相等就说明没人插话，`auto` 便不引用。
    noteChatter(event, selfId);
    const admitted = admit(event, selfId);
    if (admitted === undefined) {
      rememberAmbient(event, selfId);
      return;
    }
    const { conversation, message, quote } = admitted;
    const sender = event.sender ?? {};
    const who = conversation.type === 'group' ? `群 ${conversation.id}` : `私聊 ${conversation.id}`;
    // 兜底清理归属表，避免「消息入队了但 turn 始终没被 claim」导致无限增长。
    if (submitted.size > 512) submitted.clear();
    // 禁漫下载指令走**旁路**：它不进会话队列、也不建 Agent 会话。整本要下十几分钟，
    // 排在队列里会把后面所有消息堵死；而且「/jm 123」是一个明确任务，不需要模型参与。
    const jmCommand = readJmCommand(messageToText(message, selfId).trim());
    if (jmCommand !== undefined) {
      report('info', `← ${who} ${sender.nickname ?? ''}: ${jmCommand.ref === undefined ? '（/jm 缺车号）' : `jm ${jmCommand.ref.id}`}`);
      if (jmCommand.ref === undefined) {
        void sendToConversation(conversation, `用法：${config.jmCommand.trim() || '/jm'} <车号 或 18comic 链接>`, { quote });
      } else {
        void runJmCommand(conversation, jmCommand.ref, quote);
      }
      return;
    }
    // 挂到会话的串行链尾：先把媒体落盘、渲染出真正的正文，再确保 Agent 就绪、登记消息
    // 归属并投递。媒体下载放在队列里而不是队列外，是为了让同一会话的消息严格按到达顺序
    // 处理 —— 否则「先发图、再说那句话」可能被下载耗时颠倒过来。
    conversation.queue = conversation.queue
      .then(async () => {
        const media = await resolveMessageMedia(message);
        const body = dropPrefix(messageToText(message, selfId, media).trim());
        report('info', `← ${who} ${sender.nickname ?? ''}: ${body.slice(0, 120)}`);
        // 会话重置指令：整条消息恰好等于指令才触发，且只清空「发指令的这个会话」。
        // 到这一步时在途的 turn 已经处理完，不会打断一半的往返。
        if (resetCommand.length > 0 && body.toLowerCase() === resetCommand) {
          const cleared = await resetConversation(conversation);
          await sendToConversation(conversation, cleared ? '已清空本会话记忆。' : '（清空失败：没能删掉会话记录，请查看机器人日志）');
          return;
        }
        const agent = await ensureAgent(conversation);
        const userMessage = createUserMessage({
          content: [{ type: 'text', text: body }],
          source: { kind: 'user' },
        });
        submitted.set(userMessage.id, { key: conversation.key, quote });
        agent.followup(userMessage);
      })
      .catch((error) => {
        const detail = error?.message ?? String(error);
        report('warn', `could not queue for ${conversation.key}: ${detail}`);
        // 静默会被当成「机器人不理人」，所以把失败原因回给发消息的人。
        void sendToConversation(conversation, `（我这边出错了：${detail}）`);
      });
  }

  // ---- 持久化事件路由 --------------------------------------------------------
  // 回复链路：submitted（消息 → 会话）→ agent/inbox/claimed（开启 turn）→
  // session/event 累积 assistant 文本 → turn/end 时把最后一条文本发回 QQ。

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    // 只认自己提交过的消息；认领后即可从 submitted 移除，改由 turnOwners 记账。
    const owner = submitted.get(message.id);
    if (owner === undefined) return;
    submitted.delete(message.id);
    turnOwners.set(`${agent.id}:${turn}`, owner);
  });

  ctx.on('session/event', (session, event) => {
    // 与本插件无关的会话事件直接忽略。
    const key = sessionIndex.get(session.id);
    if (key === undefined) return;
    if (event.type === 'assistant/message') {
      // 逐条累积：一轮里可能有多步 assistant 消息，最后一轮的第一条与最后一条不一定相同。
      const text = visibleText(event.data.message.content);
      if (text.length === 0) return;
      const slot = `${session.id}:${event.data.turn}`;
      const list = transcripts.get(slot) ?? [];
      list.push(text);
      transcripts.set(slot, list);
      return;
    }
    if (event.type !== 'turn/end') return;
    // turn 结束：取走累积文本与归属信息（无论是否要回复，都要清理，防止泄漏）。
    const slot = `${session.id}:${event.data.turn}`;
    const list = transcripts.get(slot);
    transcripts.delete(slot);
    const owner = turnOwners.get(slot);
    turnOwners.delete(slot);
    if (owner === undefined) return;
    const conversation = conversations.get(owner.key);
    if (conversation === undefined) return;
    const reason = event.data.reason?.kind;
    // 被打断 / fork 掉 / 中止的 turn 不是有效回复，静默丢弃。
    if (reason === 'aborted' || reason === 'forked' || reason === 'interrupted') return;
    if (reason === 'error') {
      void sendToConversation(conversation, '（我这边处理时出错了，稍后再试试）');
      return;
    }
    // 只发该 turn 里最后一条有文本的 assistant 消息；中间步骤的工具调用等不发给 QQ。
    const reply = list?.[list.length - 1]?.trim() ?? '';
    if (reply.length === 0) return;
    report('info', `→ ${conversation.key}: ${reply.slice(0, 120)}`);
    // 自动回复走「拟人」通道：拆短句 + 打字延迟 + 引用/@ 对方。
    void sendToConversation(conversation, reply, { human: true, quote: owner.quote });
  });

  // ---- 工具注册 --------------------------------------------------------------

  /**
   * 工具一：qq_send_message —— 主动向某个 QQ 号或群号发文本（超长自动分段）。
   * 面向所有 Harness Agent 全局可用，包括 Web UI 里的主会话。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_send_message',
      description:
        'Send a text message through the connected QQ (OneBot) account to one QQ contact or group. Requires the QQ bridge plugin to be connected; use qq_list_conversations first when the target id is unknown.',
      parameters: {
        target_type: {
          type: 'string',
          enum: ['private', 'group'],
          required: true,
          description: 'Whether the target id is a QQ number (private) or a group number (group).',
        },
        target_id: {
          type: 'string',
          required: true,
          description: 'The QQ number for private targets, or the group number for group targets.',
        },
        message: {
          type: 'string',
          required: true,
          description: 'The plain-text message body to send. Long text is split automatically.',
        },
      },
      // 输出结构：回显目标与实际发送的段数，便于模型确认「发了几条」。
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_type: { type: 'string', required: true },
            target_id: { type: 'string', required: true },
            parts: { type: 'integer', required: true },
          },
        },
        // render 决定这条工具结果如何呈现给调用它的 Agent（人可读的摘要）。
        render: (_args, value) => [
          { type: 'text', text: `Sent ${value.parts} QQ message part(s) to ${value.target_type} ${value.target_id}.` },
        ],
      },
      async execute(args) {
        // 未连接时直接报错，而不是静默丢弃消息。
        if (!client.connected) throw new Error(`QQ bridge is not connected to ${config.endpoint}; start NapCat or check the endpoint.`);
        const targetType = args.target_type;
        const targetId = String(args.target_id).trim();
        const body = String(args.message ?? '').trim();
        if (targetId.length === 0) throw new Error('qq_send_message requires a non-empty target_id');
        if (body.length === 0) throw new Error('qq_send_message requires a non-empty message');
        const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
        const idKey = targetType === 'group' ? 'group_id' : 'user_id';
        // 这是 Agent 的显式动作（「就发这段」），所以只按协议上限分段：
        // 不做拆句、不加打字延迟 —— 拟人节奏只加在 QQ 会话的自动回复上。
        const parts = chunkText(body, protocolLimit());
        for (const part of parts) await client.call(action, { [idKey]: targetId, message: part });
        return { target_type: targetType, target_id: targetId, parts: parts.length };
      },
    }),
  );

  /**
   * 工具二：qq_list_conversations —— 列出在线群/好友，以及本 Harness 已处理过的
   * QQ 会话及其 Session id，同时附带当前生效的模型路由（便于排查 MISSING_CREDENTIAL
   * 之类的模型问题）。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_list_conversations',
      description:
        'List QQ contacts reachable through the connected OneBot account: the live group and friend lists, plus every QQ conversation this Harness has already handled and its Session id.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean', required: true },
            self_id: { type: 'string' },
            groups: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                },
              },
            },
            friends: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                },
              },
            },
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  conversation: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  session_id: { type: 'string', required: true },
                },
              },
            },
            route: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                source: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [`QQ bridge connected: ${value.connected}${value.self_id ? ` (account ${value.self_id})` : ''}`];
          lines.push(`QQ session model: ${value.route.model || '(none)'} via ${value.route.provider || '(none)'} [${value.route.source}]`);
          if (value.route.error.length > 0) lines.push(`Route warning: ${value.route.error}`);
          if (value.groups.length > 0) lines.push('', 'Groups:', ...value.groups.map((g) => `  ${g.id} ${g.name}`));
          if (value.friends.length > 0) lines.push('', 'Friends:', ...value.friends.map((f) => `  ${f.id} ${f.name}`));
          if (value.sessions.length > 0) {
            lines.push('', 'Handled conversations:', ...value.sessions.map((s) => `  ${s.conversation} (${s.name}) → session ${s.session_id}`));
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        const groups = [];
        const friends = [];
        // 未连接时这两项为空数组（而不是报错），其余信息照常返回，方便定位问题。
        if (client.connected) {
          try {
            for (const group of (await client.call('get_group_list')) ?? []) {
              groups.push({ id: String(group.group_id), name: String(group.group_name ?? '') });
            }
          } catch (error) {
            report('warn', `get_group_list failed: ${error?.message ?? error}`);
          }
          try {
            for (const friend of (await client.call('get_friend_list')) ?? []) {
              friends.push({ id: String(friend.user_id), name: String(friend.nickname ?? '') });
            }
          } catch (error) {
            report('warn', `get_friend_list failed: ${error?.message ?? error}`);
          }
        }
        const chosen = resolveRoute();
        return {
          connected: client.connected,
          self_id: client.selfId,
          groups,
          friends,
          route: { provider: chosen.provider, model: chosen.model, source: chosen.source, error: chosen.error },
          // sessions 来自已处理过的会话表；session_id 现场派生，因此与 QQ 号一一对应且稳定。
          sessions: [...conversations.values()].map((conversation) => ({
            conversation: conversation.key,
            type: conversation.type,
            name: conversation.name || conversation.senderName,
            session_id: sessionIdFor(conversation.key),
          })),
        };
      },
    }),
  );

  /**
   * 工具三：qq_jm_pdf —— 下载禁漫（JM）本子/单话，合并成 PDF，并发到 QQ。
   *
   * 从 QQ 会话里调用时可以不填目标：调用它的那个 Agent 对应的会话就是收件人
   * （`exec.agent.id` → 会话 key）。Web UI 里的主会话调用时必须显式给目标。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_jm_pdf',
      description:
        'Download a JM (18comic) album or chapter, merge every page into one PDF, and send that PDF to a QQ contact or group through the OneBot bridge. Accepts a bare JM id, "JM123456", or an 18comic album/photo URL. Called from inside a QQ conversation, the current conversation is the default recipient. Long: a whole multi-chapter album can take minutes, and the file upload itself is slow.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'JM album id or chapter id (digits), "JM123456", or a full 18comic album/photo URL.',
        },
        kind: {
          type: 'string',
          enum: ['auto', 'album', 'chapter'],
          description: 'auto (default): the whole album when the id is an album id, otherwise just that chapter. album = every chapter merged into one PDF. chapter = only the chapter with this id.',
        },
        target_type: {
          type: 'string',
          enum: ['private', 'group'],
          description: 'Where to send the PDF. Defaults to the QQ conversation this tool was called from.',
        },
        target_id: {
          type: 'string',
          description: 'QQ number (private) or group number (group) to send the PDF to. Defaults to the current QQ conversation.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_name: { type: 'string', required: true },
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            pages: { type: 'integer', required: true },
            bytes: { type: 'integer', required: true },
            chapters: { type: 'integer', required: true },
            target_type: { type: 'string', required: true },
            target_id: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Downloaded ${value.title || value.file_name} (${value.chapters} chapter(s), ${value.pages} page(s), ${value.bytes} bytes) ` +
              `into ${value.path} and sent ${value.file_name} to ${value.target_type} ${value.target_id}.`,
          },
        ],
      },
      async execute(args, exec) {
        const ref = parseJmRef(args.id);
        if (ref === undefined) throw new Error(`qq_jm_pdf could not find a JM id in "${args.id}"`);
        const kind = args.kind ?? ref.kind;
        // 收件人：显式给的优先；否则看调用它的 Agent 是不是某个 QQ 会话的 Agent。
        const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
        const targetType = args.target_type ?? fromAgent?.type;
        const targetId = args.target_id !== undefined ? String(args.target_id).trim() : fromAgent?.id;
        if (targetType === undefined || targetId === undefined || targetId.length === 0) {
          throw new Error('qq_jm_pdf needs target_type and target_id when it is not called from a QQ conversation');
        }
        // 目标就是调用方自己那个会话时，复用它的记录（发送也就跟着那条串行链走）。
        const conversation = fromAgent !== undefined && fromAgent.type === targetType && fromAgent.id === targetId
          ? fromAgent
          : targetConversation(targetType, targetId);
        const job = await downloadJm({ conversation, ref: { id: ref.id, kind } });
        const sent = await sendJmFile(conversation, job);
        if (!sent.ok) throw new Error(`downloaded ${job.name} but could not send it to QQ: ${sent.error}`);
        return {
          file_name: job.name,
          path: job.path,
          title: job.title,
          pages: job.pages,
          bytes: job.bytes,
          chapters: job.chapters,
          target_type: targetType,
          target_id: String(targetId),
        };
      },
    }),
  );

  // ---- 连接生命周期 ----------------------------------------------------------

  // 用 ctx.effect 托管连接：插件卸载/停用时自动 dispose，不留悬挂的定时器与 socket。
  // 注意：Loader 按 URL 缓存插件模块，改源码后必须重启进程才生效（见 README）。
  ctx.effect(() => {
    client.start();
    return () => client.dispose();
  }, 'qq-bridge:onebot');

  // 下载链路的托管：关掉那个给 NapCat 取文件的小 HTTP 服务与一次性 token。
  ctx.effect(() => () => jmService.close(), 'qq-bridge:jm');
}
