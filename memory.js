/**
 * 长期记忆子系统：转录落盘、记忆文件读写、两个记忆工具的能力、每日摘要循环。
 *
 * 目录里放什么、为什么「记」在这里而「读/写」交给模型，见下面
 * `// ---- 长期记忆：目录、布局边界与内存态 ----` 那一节。
 *
 * 从 `index.js` 搬出来，是因为这一整块（目录派生 + 五张内存账 + 摘要的串行链）自成一个
 * 子系统，而它与闭包的关系只有「读哪些配置、问哪些会话」这几件事。
 *
 * 依赖分两类，别混：
 *   - **叶子模块直接 import**（`util.js` / `filestore.js` / `onebot.js` / `image.js` /
 *     `dsh-llm`）—— 它们不依赖闭包，本来就能在任意上下文里调，绕一圈当参数传进来只是
 *     多一层看不出来的间接（`tools.js` 也是这么直接 import `chunkText` 的）。
 *   - **闭包里的状态与装配动作走 `deps`**（会话表、`settings`、`ctx`、开 Agent 的那几个
 *     动作）—— 这些只有 `index.js` 有。**绝不 import `index.js`**（那会成环）。
 *
 * 几条容易无声破坏的不变量（改动前先读这一段）：
 *
 *   - **摘要 Agent 不是记忆的载体**：它只读磁盘上的转录、只写磁盘上的记忆文件；被销毁、
 *     被重启都不影响记忆。别把「记住」实现成会话上下文里的东西。
 *   - **「一天至多一次」是日期判据**（`localDate(lastDigestAt)` vs 今天），不是「距上次
 *     ≥ N 小时」：定时器是每天一个整点，重启后同一天不能再摘要一遍。
 *   - **`digest.json` 只在摘要成功之后才推进**；失败/超时保持原样，消息由内存里的
 *     `memoryDirty` 计数兜着（重启归零，靠 `lastDigestAt` 重新数），不会算丢。
 *   - **不在启动时扫一遍**：`conversations` 在 `apply()` 那一刻还是空的，补课挂在
 *     「重启后第一条消息到达」（`maybeCatchUpDigest`）这个时刻上。
 *   - **读转录之前先 await 未完成的写入**（`writesFor` + `Promise.all`）：转录是后台
 *     追加的，不等会读到一个还没写出来的目录然后静默跳过。
 *   - **摘要 Agent 不进 `sessionIndex`**：它的 turn/end 因此不会往 QQ 发东西 —— 这是
 *     「后台会话」与「QQ 会话」唯一的区别机制。
 *   - **写边界只有一处**（`memoryRelativePath`，util.js 里的纯函数）：`qq_memory` 的写
 *     路径必须过它，`../` 与绝对路径都要被拒 —— QQ 消息是不可信输入。
 *   - **`memoryDir` 配到 `cwd` 外时记 warn 并整个停用**（工具都不注册、定时器都不挂），
 *     不是抛错 —— 与 `mediaDir` / `stickerDir` 同一套路。
 *
 * @module @qqbot/dsh-plugin-qq/memory
 */
import { appendFile, mkdir, unlink } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { errorText, localDate, localStamp, memoryOneLine, memoryRelativePath, memorySlug, msUntilDailyHour, sessionIdFor } from './util.js';
import { readJsonl, readTextOrUndefined, readdirOrEmpty, writeJsonAtomic, writeTextAtomic } from './filestore.js';
import { collectMedia, messageToText } from './onebot.js';
import { insideDirectory } from './image.js';
import { appendStickerRow, hotCognitionLines, normalizeCognitionDoc, normalizeStickerDoc, parseCognition, parseStickerCatalog, removeCognitionRow, removeStickerRow, renameStickerRow, stickerCatalogLines, upsertCognitionRow, upsertStickerRow } from './cognition.js';
import {
  archivePlan,
  parseMemoryDoc,
  parsePeopleDoc,
  personEntriesOf,
  recordsFromCognition,
  removeMemoryRow,
  removePersonRow,
  renderMemoryBlock,
  upsertMemoryRow,
  upsertPersonRow,
} from './memory-select.js';

/** 认知库、表情包目录与全局人物表的文件名（都在 memoryDir 根下，与 INDEX.md 同级）。 */
const COGNITION_FILE = 'COGNITION.md';
const STICKERS_FILE = 'STICKERS.md';
/** 全局人物表（设计 §3）：QQ 号为主键，跨群共用。 */
const PEOPLE_FILE = 'PEOPLE.md';
/** 派生索引：命中次数 / 最近命中时间（可删可重建，键在 memory-select.js 的 record.id）。 */
const STATS_FILE = 'memory.index.json';
/** 冷层目录（会话目录下）：滚下来的老条目，只参与 search，不进提示词。 */
const ARCHIVE_DIR = 'archive';
/** 表情包目录注入提示词的上限：与旧 STICKER_PROMPT_MAX 一致，别让目录把提示词撑爆。 */
const STICKER_CATALOG_MAX = 40;
/** 热梗段的上限：15 条 / 1200 字（见 cognition.js 的 hotCognitionLines）。 */
const HOT_COGNITION_LIMIT = 15;
const HOT_COGNITION_MAX_CHARS = 1200;
/** 这两个文件每轮都要读：用 mtime+size 判定缓存，避免每次装配提示词都读两遍盘。 */
const CATALOG_CACHE_MS = 5000;

/** 每个记忆文件在 `.history/` 里最多留几份旧版本（写坏时人工翻回去用）。 */
const HISTORY_KEEP = 20;

/**
 * `INDEX.md` 注入提示词的上限。
 *
 * 索引是部署者 / 摘要 Agent 手写的**短**索引，不是记忆正文；这里的截断只是兜底，
 * 防止一份被写坏的索引把 `memoryPromptChars` 吃光。真正的记忆走检索（memory-select）。
 */
const INDEX_PROMPT_MAX_CHARS = 1500;

/** 派生索引统计写的防抖（毫秒）：提示词每轮都会装配，不能每次都写一次盘。 */
const STATS_SAVE_MS = 2000;

/** 转录里单条消息最多保留多少字：摘要只需要「大概说了什么」，不需要全文。 */
const MEMORY_LINE_MAX_CHARS = 500;

/**
 * `qq_memory read` 一次最多返回多少字符。
 *
 * 读不设「拒绝」的硬上限（该翻的时候要能翻个够），但一次工具结果塞进上下文的东西
 * 必须有数：超出的部分截断并明说，模型据此自己决定要不要用 search 精确定位。
 */
const MEMORY_FILE_RETURN_CHARS = 12000;

/**
 * 建一份长期记忆子系统。
 *
 * @param {object} deps - 需要的闭包状态与外部能力，全部显式传入（照 `tools.js` 的做法，
 *   模块自己不 import `index.js`）：
 *   - `ctx`：Host 上下文（`agents` 开摘要会话、`get('approval')` 收审批策略）。
 *   - `settings`：配置的运行时视图（`memory*` / `digest*` 与准入白名单都从这里读）。
 *   - `cwd`：Agent 工作目录，同时也是 `memoryDir` 越界校验的基准。
 *   - `report`：`(level, msg)` 运维日志（index.js 里那个 logger + stderr 的镜像）。
 *   - `conversations` / `sessionIndex`：会话表与 session id → key 的反查，解析「在说哪个会话」用。
 *   - `ambientQuery`：`(conversation) => string`，把这个群最近几条闲聊拼成检索查询；
 *     主动说话 / 补一句 / 提醒这些「没有来消息」的轮次靠它决定这一轮该捞哪些记忆。
 *   - `allowTools`：工具白名单 —— 「记忆工具到底可不可见」跟着它走。
 *   - `approvalPolicy`：摘要 Agent 也按这个策略收审批。
 *
 *   `createUserMessage` / `sessionIdFor` / `errorText` / `messageToText` / `collectMedia` /
 *   `insideDirectory` **不在这里**：它们是叶子模块的纯函数或构造器，本模块直接 import。
 *   - `resolveRoute` / `resolveAgentPreset` / `mountAgentPreset` / `restrictAgentTools` /
 *     `channelSectionOrder`：开摘要 Agent 要用的那套装配动作（与 QQ 会话共用）。
 * @returns 见文件末尾的返回对象：`enabled` / `label` 给启动自述与渠道提示，`tools` 交给
 *   `registerQqTools`，其余是 index.js 的调用点。
 */
export function createMemory(deps) {
  const {
    ctx,
    settings,
    cwd,
    report,
    conversations,
    sessionIndex,
    ambientQuery,
    allowTools,
    approvalPolicy,
    resolveRoute,
    resolveAgentPreset,
    mountAgentPreset,
    restrictAgentTools,
    channelSectionOrder,
  } = deps;

  // ---- 长期记忆：目录、布局边界与内存态 ----
  //
  // 三样东西同住 memoryDir（默认 `.qq-memory`，必须在 cwd 内 —— 它是 qq_memory 工具的
  // 写入边界，也是摘要 Agent 唯一允许动手的地方）：
  //
  //   conversations/<key>/{meta.json,log/YYYY-MM-DD.jsonl}   每个会话的聊天记录（原始事实）
  //   conversations/<key>/MEMORY.md                           这个群的长期记忆
  //   COGNITION.md                                            跨会话的公共认知（梗 / 黑话 / 谐音 —— **只有文字**）
  //   STICKERS.md                                             表情包目录（名字 / 含义 / 收藏后的路径）
  //   INDEX.md                                                两份索引的拼接，注入渠道提示
  //
  // 认知与表情包为什么是两个文件：键根本不同。梗的键是文字写法，表情包的键是收藏后的
  // 文件名 —— 混在一个文件里时，表情包条目会拿 `.qq-media/<哈希>`（LRU 缓存，会过期）
  // 当键，迟早变成一条死链。详见 `cognition.js` 的模块注释。
  //
  // 插件只负责**记**（每条入站消息同步落一行），**读/写**交给模型通过
  // qq_transcript / qq_memory 两个工具做 —— 好处是纯宿主平面工具，QQ 会话不用为了
  // 记忆拿到 write / bash；摘要则由下面的定时器驱动一个独立会话跑 message-digest skill。
  const memoryOn = settings.memory !== false;
  const memoryCfg = typeof settings.memoryDir === 'string' ? settings.memoryDir.trim() : '';
  const memoryRoot = memoryCfg.length > 0 ? resolve(cwd, memoryCfg) : undefined;
  const memoryInside = memoryRoot !== undefined && insideDirectory(resolve(cwd), memoryRoot);
  if (memoryOn && memoryRoot !== undefined && !memoryInside) {
    report('warn', `memoryDir "${memoryCfg}" resolves outside cwd (${cwd}); episodic memory is disabled`);
  } else if (memoryOn && memoryRoot === undefined) {
    report('warn', 'memory is enabled but memoryDir is empty; episodic memory is disabled');
  }
  const memoryEnabled = memoryOn && memoryInside;
  /** 记忆目录的展示路径（相对 cwd、正斜杠），提示词与工具返回值里都用它。 */
  const memoryLabel = memoryEnabled ? relative(resolve(cwd), memoryRoot).split(sep).join('/') : '';
  /**
   * 记忆目录的绝对路径（以 `/` 结尾），给「写盘」这一侧用。
   *
   * 相对路径在概念上是相对 **Agent 的 cwd** 的，所以必须解析成绝对路径再拼。
   *
   * 这里原本有一条「`memoryDir` 与 `stickerDir` 同名时复用已解析的 stickerRoot」的兼容
   * 分支，搬运时核过它**恒等于**下面这一条：分支成立时两个配置串相等，而两边的算法都是
   * `resolve(cwd, 那个串)`，算出来逐字节相同 —— 一条永远走不到别处的分支，留着只会让人
   * 以为「记忆目录有可能落在表情包目录上」。删掉，顺带少一个 deps 字段。
   */
  const memoryBase = memoryEnabled ? `${memoryRoot}${sep}` : undefined;
  /** 会话 key → 记忆目录下的安全子目录名（见 memorySlug）。 */
  const memorySlugs = new Map();
  /** 会话 key → 上一次成功摘要之后、这个会话又来了多少条消息（内存计数，重启归零）。 */
  const memoryDirty = new Map();
  /**
   * 会话 key → 上一次成功摘要的时间戳。
   *
   * 启动时从 `digest.json` 预读进内存，之后每次摘要就地更新：它既是转录窗口的起点，
   * 也是「今天这条会话摘要过没有」的判据（见 `runDigestSweep`），而 `runDigestSweep`
   * 是定时器回调（每天 `digestAtHour` 点一次），不该每次都去磁盘上读一遍状态。
   */
  const memoryLastDigest = new Map();
  /** 记忆文件的写盘队列（每个文件一条串行链，见 writeMemoryFile）。 */
  const memoryWrites = new Map();
  /** 这次启动是否已经跑过一轮「补课」摘要（见 maybeCatchUpDigest）。 */
  let digestCatchUpKicked = false;
  /**
   * 派生索引里的统计：`{ [record.id]: { hits, lastSeen } }`。
   *
   * 它不是真相（删掉也能从 markdown 重建记录），只影响打分里的 salience / recency
   * 与滚档时「谁最不活跃」。读写失败一律降级成「没有统计」，绝不让它挡住装配。
   */
  let memoryStats = {};
  /** 统计是否从磁盘读过（第一次装配提示词是同步的，来不及 await）。 */
  let statsLoaded = false;
  /** 统计的防抖写盘定时器。 */
  let statsTimer;
  /**
   * 摘要会话**正在处理哪个会话**（`group:<id>` / `private:<qq>`）。
   *
   * `qq_memory` 的写入闸门要判断「这次写是不是从私聊里发起的」，而摘要 Agent 不是任何
   * QQ 会话的 Agent（不在 `sessionIndex` 里）。所以摘要轮开始时把目标记在这里，
   * `runDigest` 结束时清掉 —— 见 `writeScopeOf`。
   */
  let digestTarget;
  /** 全局人物表的一次性迁移是否跑过（每个进程一次）。 */
  let peopleMigrated = false;
  /** 同步读数缓存：绝对路径 → `{ key, text }`（key = size:mtime）。 */
  const fileTextCache = new Map();
  /** 全局文件（PEOPLE / COGNITION）的解析缓存，按两份文件的 mtime 失效。 */
  let globalRecordsCache = { key: '', records: [], warnings: [] };
  /** 会话热层的解析缓存：会话 key → `{ key, records, warnings }`。 */
  const conversationRecordsCache = new Map();
  /** `archive/` 月份清单的缓存：会话 key → `{ at, months }`。 */
  const archiveMonthsCache = new Map();

  /** 摘要 Agent 的会话 id（确定性派生，重启后 resume，摘要历史不会断）。 */
  const digestSessionId = sessionIdFor('bridge:digest');
  /** 摘要任务的串行链：一次只跑一个会话，也不与自己的下一轮重叠。 */
  let digestChain = Promise.resolve();
  /** 已经排进队列、还没跑完的会话 key，避免同一个会话被重复排队。 */
  const digestQueued = new Set();
  /**
   * 取一个会话在记忆目录下的安全目录名（每个进程只算一次，保证稳定）。
   * @param key - 会话 key。
   * @returns 目录名，例如 `group-100000001`。
   */
  function memorySlugFor(key) {
    let slug = memorySlugs.get(key);
    if (slug === undefined) {
      slug = memorySlug(key);
      memorySlugs.set(key, slug);
    }
    return slug;
  }

  /** 某个会话在记忆目录下的绝对路径集合（会话目录、转录目录、记忆文件、冷层）。 */
  function memoryPaths(key) {
    const slug = memorySlugFor(key);
    const dir = join(memoryRoot, 'conversations', slug);
    return {
      slug,
      dir: `${dir}${sep}`,
      logDir: `${join(dir, 'log')}${sep}`,
      archiveDir: `${join(dir, ARCHIVE_DIR)}${sep}`,
      memoryFile: join(dir, 'MEMORY.md'),
      metaFile: join(dir, 'meta.json'),
    };
  }

  /** 索引片段与认知库的绝对路径（两者都在记忆目录顶层）。 */
  const memoryIndexFile = memoryEnabled ? join(memoryRoot, 'INDEX.md') : undefined;
  /** 全局人物表与派生索引的绝对路径。 */
  const memoryPeopleFile = memoryEnabled ? join(memoryRoot, PEOPLE_FILE) : undefined;
  const memoryStatsFile = memoryEnabled ? join(memoryRoot, STATS_FILE) : undefined;

  /**
   * 某个目录下已经排队的转录写入（用来在**读**之前把写等干净）。
   *
   * 读转录的两条路（摘要、`qq_transcript`）都可能紧跟在一条消息后面发生，而写入是
   * 后台排队的 —— 这里把在飞的 Promise 交出去，调用方 `await` 一下就得到「写完了」
   * 这个确定状态。
   * @param dir - 转录目录的绝对路径（以分隔符结尾）。
   * @returns 该目录下所有未完成的写入 Promise。
   */
  function writesFor(dir) {
    const pending = [];
    for (const [file, promise] of memoryWrites) {
      if (file.startsWith(dir)) pending.push(promise);
    }
    return pending;
  }

  /**
   * 把聊天记录按会话串行追加到当天转录里（qq_transcript 的原料）。
   *
   * 这里刻意**不**等落盘：`handleEvent` 是 OneBot 事件的热路径（攒批定时器也在它
   * 里面），一次 await 就会把「消息有没有被及时接住」交给磁盘。所以写是后台的，
   * 按会话排队（`memoryWrites`），失败只记一条 warn。
   *
   * @param conversation - 归属的会话记录。
   * @param line - 已渲染成一行的一条记录。
   * @param date - 日期（`YYYY-MM-DD`）。
   */
  function appendTranscript(key, line, date, conversation) {
    const paths = memoryPaths(key);
    const file = join(paths.logDir, `${date}.jsonl`);
    const previous = memoryWrites.get(file) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(paths.logDir, { recursive: true });
        await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
      })
      .catch((error) => {
        report('warn', `could not append transcript for ${key}: ${errorText(error)}`);
      });
    memoryWrites.set(file, next);
    // 这个会话还没有目录（第一次说话）时落一份元信息，qq_transcript 的 list 靠它认出群名。
    if (conversation !== undefined && conversation.metaWritten !== true) {
      conversation.metaWritten = true;
      void (async () => {
        try {
          await mkdir(paths.dir, { recursive: true });
          const existing = await readTextOrUndefined(paths.metaFile);
          const parsed = existing === undefined ? undefined : JSON.parse(existing);
          await writeJsonAtomic(paths.metaFile, {
            key: conversation.key,
            type: conversation.type,
            id: conversation.id,
            name: conversation.name || conversation.senderName,
            createdAt: parsed?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          report('warn', `could not write memory meta for ${conversation.key}: ${errorText(error)}`);
        }
      })();
    }
  }

  /**
   * 收下一条入站消息时顺手记一行转录。
   *
   * 只记**别人的**消息（机器人自己发出去的话不算群里的历史，按 selfId 排除），
   * 并且限定在插件本来就允许处理的范围内（私聊开关、群白名单、私聊白名单）——
   * 记忆不该成为绕过准入规则的后门。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @param state - `handleEvent` 已有的判定结果 `{ admitted, reset }`。
   */
  function rememberTranscript(event, selfId, state) {
    if (!memoryEnabled) return;
    if (event?.post_type !== 'message') return;
    if (selfId === '' || String(event.user_id ?? '') === String(selfId)) return;
    const isGroup = event.message_type === 'group';
    if (isGroup) {
      if (!settings.groupChat) return;
      const groupId = String(event.group_id);
      if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return;
    } else {
      if (!settings.privateChat) return;
      const userId = String(event.user_id);
      if (settings.allowUsers.length > 0 && !settings.allowUsers.includes(userId)) return;
    }
    const message = event.message ?? event.raw_message;
    const text = memoryOneLine(messageToText(message, selfId)).slice(0, MEMORY_LINE_MAX_CHARS);
    const sender = event.sender ?? {};
    const name = isGroup
      ? String(sender.card ?? sender.nickname ?? event.user_id ?? '')
      : String(sender.nickname ?? sender.card ?? event.user_id ?? '');
    const write = (key, extra = {}, conversation) => {
      const date = localDate();
      appendTranscript(key, {
        at: Date.now(),
        date,
        // state 由 handleEvent 一次算好：被 @ 的（进会话）与只是路过的（环境上下文）都记，
        // 但标出来 —— 摘要时「它是被叫到才说话」和「它只是看着」是两种不同的事实。
        kind: isGroup ? 'group' : 'private',
        addressed: state.admitted !== undefined,
        command: state.reset ? 'reset' : undefined,
        id: String(event.message_id ?? ''),
        user: String(event.user_id ?? ''),
        name,
        text,
        hasMedia: collectMedia(message).length > 0,
        ...extra,
      }, date, conversation);
      memoryDirty.set(key, (memoryDirty.get(key) ?? 0) + 1);
    };
    // 没被 @ 的群消息**不建**会话记录（`conversations` 是「这个 Harness 处理过哪些会话」
    // 的表，qq_list_conversations 与摘要调度都读它 —— 让一条闲聊把某个群「变成处理过」
    // 是行为上的谎言）。转录仍然照记：长期记忆的原料正是那些没人 @ 它的闲聊。
    const admitted = state.admitted;
    if (admitted === undefined) {
      write(`${isGroup ? 'group' : 'private'}:${isGroup ? event.group_id : event.user_id}`);
      return;
    }
    write(admitted.conversation.key, {}, admitted.conversation);
    // 顺手看一眼这个会话是不是「本该在今天的摘要点被摘要、却错过了」—— 比如凌晨 4 点
    // 那一刻进程正好在重启，或者这个会话是重启之后才有人说话的（启动时的补课扫不到它：
    // 那时 conversations 还是空的）。判据由 cd 时间决定，所以一天最多补一次。
    maybeCatchUpDigest(admitted.conversation);
  }

  /**
   * 一条消息被撤回时，在转录里追加一行 tombstone。
   *
   * 为什么是**追加**而不是删掉原来那行：转录是只追加的原料，删行要重写文件，既破坏
   * 「写边界只有一处」（`memoryRelativePath`）的约定，也会让摘要状态（`lastDigestAt` /
   * `memoryDirty`）跟着要改。留一行标记的好处是双向的：摘要 Agent 能看出「这句撤了、
   * 别当事实」，而原文仍然在（群友自己回头查也查得到）。
   *
   * `kind: 'recall'` 让 `qq_transcript` 与 `renderTranscriptWindow` 都能一眼认出来；
   * `text` 填一句话而不是空串 —— 两处渲染都是直接拼 `text`，空串会显示成「kaguya: 」。
   * 措辞刻意是中性的：管理员替别人撤了话时，「撤回了自己上一条」是错的。
   *
   * 写失败只记 warn（`appendTranscript` 本来就是尽力而为），不影响那一轮回复。
   *
   * @param key - 会话 key（`group:<群号>` / `private:<QQ号>`）。
   * @param info.messageId - 被撤回那条的 message_id（与转录里的 `id` 对得上）。
   * @param info.userId - 被撤回那条的发送者。
   * @param info.name - 当时的显示名。
   * @param info.addressed - 那条当时是不是在叫它。
   */
  function noteRecall(key, info = {}) {
    if (!memoryEnabled) return;
    const date = localDate();
    appendTranscript(key, {
      at: Date.now(),
      date,
      kind: 'recall',
      recall: String(info.messageId ?? ''),
      user: String(info.userId ?? ''),
      name: String(info.name ?? ''),
      addressed: info.addressed === true,
      text: '（这条消息后来被撤回了）',
    }, date);
    // 这也是一行新素材：摘要该看见它（`digestMinLines` 的门槛算的是「有新东西」）。
    memoryDirty.set(key, (memoryDirty.get(key) ?? 0) + 1);
  }

  /**
   * 「今天已经过了摘要点、但这个会话今天还没摘要过」时补一次。
   *
   * 为什么不能只在启动时扫一遍：`conversations` 是运行时状态（重启即空），凌晨重启后
   * 第一个说话的人才是这条会话「重新出现」的时刻 —— 补课必须挂在这个时刻上，
   * 否则那一天的记忆要等到明天的 4:00。
   * @param conversation - 刚收到消息的会话。
   */
  function maybeCatchUpDigest(conversation) {
    if (!memoryEnabled || settings.digestCatchUp === false) return;
    const atHour = settings.digestAtHour;
    const now = new Date();
    if (now.getHours() < atHour) return; // 今天还没到点，等定时器
    const last = memoryLastDigest.get(conversation.key) ?? 0;
    if (last > 0 && localDate(last) === localDate(now.getTime())) return; // 今天摘要过了
    if (digestCatchUpKicked) return; // 一次启动只补一轮，别变成每条消息扫一遍
    digestCatchUpKicked = true;
    runDigestSweep();
  }

  /**
   * 读记忆目录里的 `digest.json`：每个会话上一次成功摘要的时间与日期。
   *
   * 放在磁盘上而不是内存里，是为了让「本该摘要但进程重启了」不会把那批消息算丢：
   * 重启后 `lastDigestAt` 还是旧值，日期判据认得出「今天还没摘要」，于是补一次。
   * @returns `{ conversations: { <key>: { lastDigestAt, lastDigestDate, lastLines, lastLabel } } }`。
   */
  async function readDigestState() {
    const text = await readTextOrUndefined(join(memoryRoot, 'digest.json'));
    if (text === undefined) return { conversations: {} };
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.conversations !== 'object' || parsed.conversations === null) {
        return { conversations: {} };
      }
      return { conversations: parsed.conversations };
    } catch (error) {
      report('warn', `could not parse digest.json (starting over): ${errorText(error)}`);
      return { conversations: {} };
    }
  }

  /** 把摘要状态写回磁盘（原子写）。 */
  async function writeDigestState(state) {
    await mkdir(memoryRoot, { recursive: true });
    await writeJsonAtomic(join(memoryRoot, 'digest.json'), state);
  }

  /**
   * 把一批转录记录渲染成给摘要 Agent 看的正文（旧 → 新）。
   *
   * 超长时**从最旧的一端**截断并明确告诉模型「前面还有更早的记录没给你」：摘要
   * 最怕的是模型以为手上这批就是全部，于是把「群里最近很安静」写成结论。
   * @param lines - 转录记录（按时间升序）。
   * @param budget - 字符预算。
   * @returns `{ text, included, dropped }`。
   */
  function renderTranscriptWindow(lines, budget) {
    const rendered = lines.map((line) => {
      const when = new Date(Number(line.at) || Date.now());
      const pad = (value) => String(value).padStart(2, '0');
      const stamp = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
      const who = String(line.name ?? line.user ?? '?');
      // `kind: 'recall'` 是 tombstone（见 noteRecall）：一整行只标「撤回」，摘要 agent
      // 一眼就能看出那条被撤了、别当事实。渲染窗口本来就是**一个会话**的行，所以不写
      // 「群 / 私聊」也不丢信息。
      const tags = [line.kind === 'recall' ? '撤回' : line.kind === 'private' ? '私聊' : '群'];
      if (line.addressed === true) tags.push('被叫到');
      if (line.command !== undefined) tags.push(`指令:${line.command}`);
      if (line.hasMedia === true) tags.push('带图');
      return `${stamp} [${tags.join(' ')}] ${who}: ${String(line.text ?? '')}`;
    });
    let used = 0;
    const kept = [];
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const line = rendered[index];
      if (used + line.length + 1 > budget && kept.length > 0) break;
      used += line.length + 1;
      kept.push(line);
    }
    kept.reverse();
    return { text: kept.join('\n'), included: kept.length, dropped: rendered.length - kept.length };
  }

  /**
   * 摘要 Agent：跑 message-digest skill 的那个独立会话。
   *
   * 为什么必须是独立会话而不是「往正在聊天的会话里塞一条」：QQ 会话的 persona 是
   * 一个正在群里唠嗑的群友，让它「现在开始写摘要」既污染聊天上下文，又会把摘要当
   * 聊天内容发回 QQ。独立会话则干净、可 resume（摘要历史连续）、而且它的输出本来
   * 就不经过回复链路（`sessionIndex` 里没有它）。
   */
  async function ensureDigestAgent(notice) {
    const live = ctx.agents.get(digestSessionId);
    if (live !== undefined) {
      if (digestHandle?.agent !== live) digestHandle = undefined;
      return live;
    }
    const chosen = resolveRoute();
    const agentOptions = {};
    if (chosen.provider.length > 0) agentOptions.provider = chosen.provider;
    if (chosen.model.length > 0) agentOptions.model = chosen.model;
    if (chosen.model.length === 0) {
      throw new Error(`qq-bridge: no model for the digest agent (${chosen.error}); set provider/model on the plugin`);
    }
    const presetId = await resolveAgentPreset();
    const setup = async (agentCtx, agent) => {
      await mountAgentPreset(agentCtx, agent, presetId);
      restrictAgentTools(agentCtx, agent);
      const prompt = agentCtx.get?.('systemPrompt');
      if (prompt === undefined) return;
      prompt.variable('model', () => agentOptions.model);
      prompt.variable('provider', () => agentOptions.provider);
      prompt.section({
        name: 'qq-bridge:digest',
        order: channelSectionOrder + 10,
        interpolate: false,
        text: () => digestPrompt(digestNotice),
      });
    };
    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: digestSessionId, agentOptions, setup });
      report('info', `resumed digest session ${digestSessionId}`);
    } catch {
      handle = await ctx.agents.create({
        sessionId: digestSessionId,
        meta: presetId.length > 0 ? { cwd, agentPreset: presetId } : { cwd },
        agentOptions,
        setup,
      });
      report('info', `created digest session ${digestSessionId}`);
    }
    digestHandle = handle;
    if (approvalPolicy === 'never') {
      const approval = ctx.get('approval');
      try {
        approval?.setPolicy(handle.agent, 'never');
      } catch (error) {
        report('warn', `could not set approval policy on the digest agent: ${errorText(error)}`);
      }
    }
    return handle.agent;
  }

  /** 摘要 Agent 的句柄（只在 /reset 之外的生命周期里复用；超时销毁后置空）。 */
  let digestHandle;
  /** 摘要 Agent 提示词里「这一轮要处理哪个会话」：resume 复用时由 runDigestTurn 更新。 */
  let digestNotice;

  /**
   * 同步读一个记忆文件（提示词装配用），带 `size:mtime` 缓存。
   *
   * `SystemPrompt.section()` 的 text provider 是**同步**求值的，没法 await。记忆文件
   * 单份有 `memoryFileMaxBytes` 兜底（默认 32KB），一次 stat + 命中缓存时零读取 ——
   * 比再引入一套异步刷新与失效简单得多，也不会出现「这一轮看的是上一轮的缓存」。
   * @param {string|undefined} absolute - 绝对路径。
   * @returns `{ text, key }`：文件不存在时 `{ text: '', key: 'missing' }`。
   */
  function readSyncText(absolute) {
    if (absolute === undefined) return { text: '', key: 'missing' };
    try {
      const info = statSync(absolute);
      const key = `${info.size}:${info.mtimeMs}`;
      const cached = fileTextCache.get(absolute);
      if (cached !== undefined && cached.key === key) return cached;
      const fresh = { key, text: readFileSync(absolute, 'utf8') };
      fileTextCache.set(absolute, fresh);
      return fresh;
    } catch {
      return { text: '', key: 'missing' };
    }
  }

  /**
   * 全局记录：`PEOPLE.md` 的人物 + `COGNITION.md` 的梗。
   *
   * 两者都是 `scope: 'global'`，所有会话可见；缓存按两份文件的 `size:mtime` 失效，
   * 摘要 Agent 刚写完的条目下一次装配就能看见。
   */
  function globalRecords() {
    const people = readSyncText(memoryPeopleFile);
    const cognition = readSyncText(join(memoryBase, COGNITION_FILE));
    const key = `${people.key}|${cognition.key}`;
    if (globalRecordsCache.key === key) return globalRecordsCache;
    const peopleParsed = parsePeopleDoc(people.text, { file: PEOPLE_FILE });
    const cognitionParsed = parseCognition(cognition.text);
    const records = [
      ...peopleParsed.records,
      ...recordsFromCognition(cognitionParsed.entries, { file: COGNITION_FILE }),
    ];
    const warnings = [...peopleParsed.warnings, ...cognitionParsed.warnings];
    // 一份文件写坏不能让提示词装配失败：坏条目丢掉，只留前三条 warn 供排查。
    for (const warning of warnings.slice(0, 3)) report('warn', warning);
    globalRecordsCache = { key, records, warnings };
    return globalRecordsCache;
  }

  /**
   * 这个会话自己的热层记录（`conversations/<slug>/MEMORY.md`）。
   *
   * 冷层（`archive/`）**不进提示词**：它只参与 `qq_memory search`。热层才是「现在还
   * 有效」的那批事实，滚档规则见 {@link rolloverMemory}。
   */
  function conversationRecords(key) {
    const paths = memoryPaths(key);
    const own = readSyncText(paths.memoryFile);
    const cached = conversationRecordsCache.get(key);
    if (cached !== undefined && cached.key === own.key) return cached;
    const parsed = parseMemoryDoc(own.text, { file: `conversations/${paths.slug}/MEMORY.md`, scope: key });
    for (const warning of parsed.warnings.slice(0, 3)) report('warn', warning);
    const fresh = { key: own.key, records: parsed.records, warnings: parsed.warnings };
    conversationRecordsCache.set(key, fresh);
    return fresh;
  }

  /**
   * `archive/` 下有哪些月份（给提示词里那行**现算的**聚合行）。
   *
   * 不往 `MEMORY.md` 里写指针：指针会随滚档次数增长，几年后就会把正文挤走 ——
   * 那正是设计 §6.2 点名要修的病。这里只是 readdir + 10 秒缓存。
   */
  function archiveMonthsOf(key) {
    const cached = archiveMonthsCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < 10000) return cached.months;
    let months = [];
    try {
      months = readdirSync(memoryPaths(key).archiveDir)
        .filter((name) => /^\d{4}-\d{2}\.md$/.test(name))
        .map((name) => name.slice(0, 7))
        .sort();
    } catch {
      months = []; // 还没建 / 读不到：当作「没有归档」，不影响这一轮。
    }
    archiveMonthsCache.set(key, { at: Date.now(), months });
    return months;
  }

  /**
   * 这一轮的检索查询：当前消息（`conversation.recallQuery`）+ 群环境 + 说话人。
   *
   * 主动说话 / 补一句 / 提醒这些没有「来消息」的轮次，`recallQuery` 会退回上一条消息
   * 或群环境（`deps.ambientQuery`）—— 设计 §5.1。说话人用来保证「人物必进」。
   * @param conversation - 目标会话。
   * @returns `{ text, focus }`。
   */
  function recallQueryFor(conversation) {
    const recent = conversation?.recallQuery;
    const parts = [];
    if (recent !== undefined && String(recent.text ?? '').trim().length > 0) parts.push(String(recent.text));
    const ambient = typeof ambientQuery === 'function' ? String(ambientQuery(conversation) ?? '') : '';
    if (ambient.trim().length > 0) parts.push(ambient.trim());
    const speakers = recent?.speakers ?? conversation?.speakers ?? [];
    const focus = speakers.map((speaker) => String(speaker?.name ?? '').trim()).filter((name) => name.length > 0);
    return { text: parts.join('\n').slice(0, 4000), focus };
  }

  /** 记一次「被命中」：salience 与滚档的「最不活跃」都靠它。 */
  function bumpStats(records) {
    if (!statsLoaded) return; // 统计还没从磁盘读进来，别用空表覆盖它
    const now = Date.now();
    for (const record of records) {
      const entry = memoryStats[record.id] ?? { hits: 0, lastSeen: 0 };
      entry.hits = Math.max(0, Number(entry.hits) || 0) + 1;
      entry.lastSeen = now;
      memoryStats[record.id] = entry;
    }
    scheduleStatsSave();
  }

  /** 统计写盘防抖：提示词每轮都装配，不能每次都写一次盘。 */
  function scheduleStatsSave() {
    if (statsTimer !== undefined) return;
    statsTimer = setTimeout(() => {
      statsTimer = undefined;
      void saveStats();
    }, STATS_SAVE_MS);
    statsTimer.unref?.();
  }

  /** 把派生索引写到 `memory.index.json`（写失败只记 warn：它只是派生物）。 */
  async function saveStats() {
    if (!memoryEnabled || !statsLoaded || memoryStatsFile === undefined) return;
    try {
      await mkdir(memoryRoot, { recursive: true });
      await writeJsonAtomic(memoryStatsFile, { version: 1, builtAt: new Date().toISOString(), stats: memoryStats });
    } catch (error) {
      report('warn', `could not write ${STATS_FILE}: ${errorText(error)}`);
    }
  }

  /**
   * 读派生索引。文件缺失 / 损坏 → 统计为空（降级成「按 pinned / 板块 / 最近取」），
   * 不抛错、不空注入 —— 见设计 §10「降级」。
   */
  async function loadStats() {
    if (!memoryEnabled || statsLoaded) return;
    statsLoaded = true;
    try {
      const text = await readTextOrUndefined(memoryStatsFile);
      if (text === undefined) return;
      const parsed = JSON.parse(text);
      const stats = parsed?.stats ?? parsed;
      if (stats !== null && typeof stats === 'object' && !Array.isArray(stats)) {
        memoryStats = Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== null && typeof value === 'object'));
      }
    } catch (error) {
      report('warn', `could not read ${STATS_FILE} (rebuilding stats from scratch): ${errorText(error)}`);
      memoryStats = {};
    }
  }

  /**
   * 记忆注入的总入口（设计 §5 / §7）：检索 + 按节配额打包 + 出处 + 词汇表 + 归档聚合行。
   *
   * 与旧的 `memoryIndexText` 的区别不是「读得更多」，而是**先按 scope 硬过滤、再按当前
   * 消息打分**：文件开头的几条无关内容不再永远占着预算，写在后半段的条目也不会永远
   * 看不见。没有命中时按 pinned / salience / 最近兜底，**绝不取文件头**。
   * @param conversation - 目标会话。
   * @returns 可直接拼进提示词的整段；没有任何内容时为空串。
   */
  function recallText(conversation) {
    if (!memoryEnabled) return '';
    const index = readSyncText(memoryIndexFile);
    const indexText = index.text.trim().slice(0, INDEX_PROMPT_MAX_CHARS);
    const now = Date.now();
    const query = recallQueryFor(conversation);
    const own = conversationRecords(conversation.key);
    const global = globalRecords();
    const archiveMonths = archiveMonthsOf(conversation.key);
    const block = renderMemoryBlock({
      records: [...global.records, ...own.records],
      query: query.text,
      scope: conversation.key,
      focus: query.focus,
      indexText,
      archiveMonths,
      stats: memoryStats,
      config: {
        promptChars: settings.memoryPromptChars,
        recallK: settings.memoryRecallK,
        peopleMax: settings.memoryPeopleMax,
        vocabHint: settings.memoryVocabHint,
      },
      now,
    });
    // 一条都没有、连索引也没写：让 index.js 说「记忆还是空的」，而不是给一个空标题。
    if (block.picked.length === 0 && indexText.length === 0 && archiveMonths.length === 0) return '';
    bumpStats(block.picked);
    return block.text;
  }

  /**
   * 认知库与表情包目录的同步读数（提示词装配用）。
   *
   * 为什么是**同步**：`SystemPrompt.section()` 的 text provider 每次装配都要重新求值，
   * 没法 await（与表情包目录用同步 `readdir`、记忆索引用后台缓存是同一个理由）。两个
   * 文件都有 `memoryFileMaxBytes` 兜底（默认 32KB），一次 `stat` + 命中缓存时零读取，
   * 代价远小于为它再引入一套异步刷新与失效。
   *
   * 缓存键是两份文件的 `size:mtime`：摘要 Agent 刚写完新条目时，下一次装配就能看见，
   * 不用等固定 TTL 过期。
   *
   * @returns `{ stickers: string[], hot: string[], catalog: boolean }`：
   *   `stickers` 是「名字（含义）」行（没有目录文件时为空数组，调用方退回裸文件名），
   *   `hot` 是热梗段，`catalog` 表示表情包目录文件到底有没有解析出条目。
   */
  function catalogState() {
    if (!memoryEnabled) return { stickers: [], hot: [], catalog: false };
    const read = (name) => {
      const absolute = join(memoryBase, name);
      try {
        const info = statSync(absolute);
        // 解析失败与空文件同义（下面两个纯函数对空串返回空结果），这里不额外抛。
        if (info.size === 0) return { text: '', key: `${info.size}:${info.mtimeMs}` };
        return { text: readFileSync(absolute, 'utf8'), key: `${info.size}:${info.mtimeMs}` };
      } catch {
        return { text: '', key: 'missing' };
      }
    };
    const cognition = read(COGNITION_FILE);
    const stickers = read(STICKERS_FILE);
    const key = `${cognition.key}|${stickers.key}`;
    if (key === catalogCache.key && Date.now() - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.text;
    const parsedStickers = parseStickerCatalog(stickers.text);
    const parsedCognition = parseCognition(cognition.text);
    // 一份文件写坏不能让提示词装配失败：坏条目在这里被丢掉，只留一条 warn 供排查。
    for (const warning of [...parsedStickers.warnings, ...parsedCognition.warnings].slice(0, 3)) report('warn', warning);
    const text = {
      stickers: stickerCatalogLines(parsedStickers.collected, { max: STICKER_CATALOG_MAX }),
      hot: hotCognitionLines(parsedCognition.entries, { limit: HOT_COGNITION_LIMIT, maxChars: HOT_COGNITION_MAX_CHARS }),
      catalog: parsedStickers.collected.length > 0,
    };
    catalogCache = { at: Date.now(), key, text };
    return text;
  }

  /** 上面那份同步读数的缓存（`{ at, key, text }`）。 */
  let catalogCache = { at: 0, key: '', text: { stickers: [], hot: [], catalog: false } };

  /**
   * 给表情包目录追加一行（`qq_save_sticker` 存完图之后调）。
   *
   * 三条刻意的取舍：
   *   - 走 `writeFile`（整份替换）而不是 append：新条目要落进「已收藏」区，而不是文件末尾——
   *     `appendStickerRow` 是纯函数，负责算出替换后的全文；
   *   - 失败**不回滚图片**：图已经落盘了，缺一行目录比丢图好（调用方只记 warn）；
   *   - 没有含义就写进「未收藏」区：写进收藏区等于让提示词里出现一条选不出来的条目。
   *
   * @param {object} entry - `{ name, meaning, scene, path, look?, date?, confidence? }`。
   * @returns `{ ok, section?, reason? }`：失败时 `reason` 是给日志的一句话。
   */
  async function appendStickerCatalog(entry) {
    if (!memoryEnabled) return { ok: false, reason: 'memory is disabled' };
    const current = (await readTextOrUndefined(join(memoryBase, STICKERS_FILE))) ?? '';
    const hasMeaning = String(entry?.meaning ?? '').trim().length > 0;
    const { text, section } = appendStickerRow(current, entry, { collected: hasMeaning });
    try {
      await writeMemoryFile(STICKERS_FILE, text, false);
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    // 下一次提示词装配立刻重读，别让「刚存的表情」等一个 TTL 才出现在目录里。
    catalogCache = { at: 0, key: '', text: catalogCache.text };
    return { ok: true, section };
  }

  /**
   * 解析 `qq_memory` 要操作的文件。
   *
   * 三种来源，按优先级：
   *   1. 显式 `path`（相对记忆目录，越界直接报错）；
   *   2. 说了 `conversation`、没说 path → 那个会话的 `MEMORY.md`；
   *   3. 都没说 → 当前 QQ 会话的 `MEMORY.md`；连会话都没有就是 `INDEX.md`。
   * @param args - 工具参数。
   * @param tool - 工具名（报错用）。
   * @param exec - 工具执行上下文。
   * @returns 记忆目录内的相对路径（正斜杠）。
   */
  function resolveMemoryPath(args, tool, exec) {
    const raw = String(args?.path ?? '').trim();
    if (raw.length > 0) {
      const relative = memoryRelativePath(memoryBase, raw);
      if (relative === undefined) {
        throw new Error(`${tool}: path "${raw}" is not inside the memory directory ${memoryLabel}/ (no absolute paths, no "..")`);
      }
      return relative;
    }
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const wanted = String(args?.conversation ?? '').trim();
    if (wanted.length > 0 || fromAgent !== undefined) {
      const target = resolveMemoryConversation(args, exec, tool);
      return `conversations/${target.slug}/MEMORY.md`;
    }
    return 'INDEX.md';
  }

  /** 记忆目录下已存在的文件（相对路径），按名称排序；没有时是空数组。 */
  async function listMemoryFiles() {
    const out = [];
    for (const top of ['INDEX.md', COGNITION_FILE, STICKERS_FILE, PEOPLE_FILE, STATS_FILE, 'digest.json']) {
      if ((await readTextOrUndefined(join(memoryBase, top))) !== undefined) out.push(`${memoryLabel}/${top}`);
    }
    for (const slug of await readdirOrEmpty(join(memoryBase, 'conversations'))) {
      for (const name of await readdirOrEmpty(join(memoryBase, 'conversations', slug))) {
        if (name.endsWith('.md') || name.endsWith('.json')) out.push(memoryRelativeConvPath(slug, name));
      }
      // 冷层：`archive/YYYY-MM.md`。它不进提示词，但 search 会搜（见 searchMemoryFile），
      // 所以 list 也必须列得出来 —— 否则模型不知道「更早的记忆」在哪。
      for (const name of await readdirOrEmpty(join(memoryBase, 'conversations', slug, ARCHIVE_DIR))) {
        if (name.endsWith('.md')) out.push(memoryRelativeConvPath(slug, `${ARCHIVE_DIR}/${name}`));
      }
    }
    return { action: 'list', files: out.sort(), returned: out.length, truncated: false };
  }

  /**
   * 读一个记忆文件，带行号。
   * @param relative - 记忆目录内的相对路径。
   * @returns 工具输出。
   */
  async function readMemoryFile(relative) {
    const text = await readTextOrUndefined(join(memoryBase, relative));
    if (text === undefined) {
      return { action: 'read', path: `${memoryLabel}/${relative}`, bytes: 0, lines_total: 0, returned: 0, truncated: false, note: '(file does not exist yet — append to create it)' };
    }
    const lines = text.split('\n');
    // 行号让模型能引用「第 12 行」，也让长文件的截断看得出来是截断。
    const numbered = lines.map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`).join('\n');
    const truncated = numbered.length > MEMORY_FILE_RETURN_CHARS;
    return {
      action: 'read',
      path: `${memoryLabel}/${relative}`,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines_total: lines.length,
      returned: lines.length,
      truncated,
      note: readWarningNote(relative, text),
      text: truncated ? `${numbered.slice(0, MEMORY_FILE_RETURN_CHARS)}\n…（已截断）` : numbered,
    };
  }

  /**
   * 读这几个文件时，把「解析不了、因此永远不会进提示词」的行直接点出来。
   *
   * 这些行是静默失效的：写在文件里、search 找得到、模型每轮却看不到（真实事故：
   * 31 条里 3 条只有一段，从来没进过提示词）。不点出来，谁都不会去修它。
   */
  function readWarningNote(relative, text) {
    const parsed = relative === COGNITION_FILE
      ? parseCognition(text)
      : relative === STICKERS_FILE
        ? parseStickerCatalog(text)
        : relative === PEOPLE_FILE
          ? parsePeopleDoc(text)
          : relative.endsWith('MEMORY.md')
            ? parseMemoryDoc(text, { file: relative })
            : undefined;
    if (parsed === undefined || parsed.warnings.length === 0) return undefined;
    return `⚠ ${parsed.warnings.length} 行不会被注入/选中（字段不全，补齐或删掉）：\n${parsed.warnings.slice(0, 3).map((line) => `  - ${line}`).join('\n')}`;
  }

  /**
   * 在记忆文件里按子串搜索（不区分大小写），返回命中行及其上下文。
   *
   * 搜一个会话的 `MEMORY.md` 时**连它的 `archive/` 一起搜**：滚到冷层的条目只是不进
   * 提示词，不是消失了（设计 §6.2）。命中行前会标出文件名，模型据此用 `qq_memory read`
   * 深挖。
   * @param relative - 记忆目录内的相对路径。
   * @param query - 要找的文本。
   * @param limit - 最多返回多少条命中。
   * @returns 工具输出。
   */
  async function searchMemoryFile(relative, query, limit) {
    const max = Math.max(1, Math.floor(Number(limit) || Number(settings.memorySearchHits) || 40));
    const needle = query.trim().toLowerCase();
    const targets = [{ path: relative, label: '' }];
    // `conversations/<slug>/MEMORY.md` → 同一个目录下的 archive/*.md 也搜。
    const conv = /^conversations\/([^/]+)\/MEMORY\.md$/.exec(relative);
    if (conv !== null) {
      const dir = join(memoryBase, 'conversations', conv[1], ARCHIVE_DIR);
      for (const name of (await readdirOrEmpty(dir)).filter((item) => item.endsWith('.md')).sort()) {
        targets.push({ path: `conversations/${conv[1]}/${ARCHIVE_DIR}/${name}`, label: `${ARCHIVE_DIR}/${name}` });
      }
    }
    const hits = [];
    let bytes = 0;
    let searched = 0;
    for (const target of targets) {
      const text = await readTextOrUndefined(join(memoryBase, target.path));
      if (text === undefined) continue;
      searched += 1;
      bytes += Buffer.byteLength(text, 'utf8');
      const lines = text.split('\n');
      for (let index = 0; index < lines.length && hits.length < max; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        const prefix = target.label.length > 0 ? `${target.label}:` : '';
        hits.push(`${prefix}${lines.slice(from, to).map((line, offset) => `${String(from + offset + 1).padStart(4, ' ')} | ${line}`).join('\n')}`);
      }
      if (hits.length >= max) break;
    }
    return {
      action: 'search',
      path: `${memoryLabel}/${relative}`,
      returned: hits.length,
      truncated: hits.length >= max,
      text: hits.length > 0 ? hits.join('\n---\n') : '(no match)',
      bytes,
      note: searched > 1 ? `searched ${searched} files (MEMORY.md + ${ARCHIVE_DIR}/)` : undefined,
    };
  }

  /**
   * 这次工具调用「是从哪个会话发起的」。
   *
   * 三个来源：QQ 会话的 Agent（`sessionIndex` 反查）、摘要 Agent（`digestTarget`）、
   * 宿主平面的 Web 主会话（都不是 → undefined，不受私聊写入闸门限制 —— 那是部署者
   * 在操作，不是 QQ 消息）。
   */
  function writeScopeOf(exec) {
    const agentId = exec?.agent?.id;
    if (agentId === undefined) return undefined;
    const key = sessionIndex.get(agentId);
    if (key !== undefined) return key;
    if (agentId === digestSessionId) return digestTarget;
    return undefined;
  }

  /**
   * 私聊写入闸门（设计 §4「scope：只降不升」的第二层）。
   *
   * `COGNITION.md` / `PEOPLE.md` 是**全局**文件；私聊里知道的事一旦写进去，就会在群里
   * 被说出来。所以这里不给「尽量避免」的余地：私聊会话对这两个文件的任何写请求
   * （write / append / upsert / remove）一律拒绝，并提示写进本会话的 `MEMORY.md`。
   *
   * 摘要 Agent 走同一条闸门（`digestTarget` 是被摘要的那个会话），它在私聊的摘要轮里
   * 一样拿不到这两个写通道。
   */
  function assertGlobalWrite(relative, exec) {
    if (relative !== COGNITION_FILE && relative !== PEOPLE_FILE) return;
    const scope = writeScopeOf(exec);
    if (scope === undefined || !String(scope).startsWith('private:')) return;
    throw new Error(
      `qq_memory: ${memoryLabel}/${relative} is shared by every conversation — a private chat must not write it ` +
        `(the same thing learned in a group, or verified from a public source, can be written there instead). ` +
        `Write it into conversations/<this chat>/MEMORY.md.`,
    );
  }

  /**
   * 热层 → 冷层的滚档（设计 §6.2）。
   *
   * 顺序是**先写归档、成功之后再重写热层**：归档失败时热层原样不动，宁可暂时超一点，
   * 也不丢条目。规则本身（挪哪些、挪完多长）在 `archivePlan`（纯函数）里，这里只碰盘。
   *
   * @param key - 会话 key。
   * @param {object} [options] - `reason` 只用于日志。
   * @returns `{ rolled, removed?, reason? }`。
   */
  async function rolloverMemory(key, { reason = 'digest' } = {}) {
    if (!memoryEnabled || !settings.memoryArchive) return { rolled: false, reason: 'disabled' };
    const paths = memoryPaths(key);
    const text = (await readTextOrUndefined(paths.memoryFile)) ?? '';
    const plan = archivePlan(text, {
      maxBytes: settings.memoryFileMaxBytes,
      ratio: settings.memoryArchiveRatio,
      stats: memoryStats,
      now: Date.now(),
    });
    if (!plan.needed) return { rolled: false, reason: 'below threshold' };
    if (!plan.rolled) {
      report('warn', `memory rollover for ${key} skipped: ${plan.reason ?? 'nothing removable'} (${plan.beforeBytes} bytes)`);
      return { rolled: false, reason: plan.reason };
    }
    try {
      for (const file of plan.archive) {
        const absolute = join(paths.dir, ARCHIVE_DIR, `${file.month}.md`);
        const existing = (await readTextOrUndefined(absolute)) ?? '';
        // 同一条（完全相同的行）已经归档过就不再写第二遍：按 id 去重的最后一道保险，
        // 也是「同一条不会既在热层又在冷层」这条不变量的落点。
        const known = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
        const rows = file.rows.filter((row) => !known.has(row.trim()));
        if (rows.length === 0) continue;
        const header = existing.trim().length === 0 ? `# 记忆归档 ${file.month}\n\n` : `${existing.replace(/\s*$/, '')}\n`;
        await mkdir(dirname(absolute), { recursive: true });
        await writeTextAtomic(absolute, `${header}${rows.join('\n')}\n`);
      }
    } catch (error) {
      // 归档写失败 → 热层保持原样：宁可暂时超一点，也不丢条目。
      report('warn', `memory rollover for ${key} could not write ${ARCHIVE_DIR}/: ${errorText(error)}`);
      return { rolled: false, reason: errorText(error) };
    }
    try {
      await writeTextAtomic(paths.memoryFile, plan.hot);
    } catch (error) {
      report('warn', `memory rollover for ${key} wrote ${ARCHIVE_DIR}/ but could not rewrite the hot layer: ${errorText(error)}`);
      return { rolled: false, reason: errorText(error) };
    }
    archiveMonthsCache.delete(key);
    report(
      'info',
      `memory rollover for ${key}: ${plan.removed.length} row(s) → ${ARCHIVE_DIR}/ (${plan.beforeBytes} → ${plan.afterBytes} bytes, ${reason})`,
    );
    return { rolled: true, removed: plan.removed.length };
  }

  /**
   * 从各会话 `MEMORY.md` 的「## 人」小节补一遍 `PEOPLE.md`（设计 §9，一次性、幂等）。
   *
   * 只补不覆盖：已经按 QQ 号 / 名字 / 别名认得的条目原样不动。文件不存在时也不会
   * 建一个空表 —— 没有人物就不写，免得提示词里多一段空标题。
   */
  async function migratePeopleDoc() {
    if (!memoryEnabled || peopleMigrated) return;
    peopleMigrated = true;
    try {
      const root = join(memoryBase, 'conversations');
      const slugs = await readdirOrEmpty(root);
      let people = (await readTextOrUndefined(memoryPeopleFile)) ?? '';
      const known = new Set(
        parsePeopleDoc(people).records.flatMap((record) => [record.qq, record.name, record.topic, ...(record.aliases ?? [])])
          .map((item) => String(item ?? '').trim().toLowerCase())
          .filter((item) => item.length > 0),
      );
      let added = 0;
      for (const slug of slugs) {
        // 只扫**群**目录：人物表是全局的，把私聊里知道的人提上去就是 scope 升级
        // （设计 §4「只降不升」）。私聊的人物留在它自己的 MEMORY.md 里。
        if (!slug.startsWith('group-')) continue;
        const text = (await readTextOrUndefined(join(root, slug, 'MEMORY.md'))) ?? '';
        for (const entry of personEntriesOf(text)) {
          const keys = [entry.qq, entry.name, ...(entry.aliases ?? [])]
            .map((item) => String(item ?? '').trim().toLowerCase())
            .filter((item) => item.length > 0);
          if (keys.some((key) => known.has(key))) continue;
          people = upsertPersonRow(people, entry).text;
          for (const key of keys) known.add(key);
          added += 1;
        }
      }
      if (added > 0) {
        await mkdir(memoryRoot, { recursive: true });
        await writeTextAtomic(memoryPeopleFile, people);
        report('info', `migrated ${added} person row(s) from conversation MEMORY.md files into ${PEOPLE_FILE}`);
      }
    } catch (error) {
      report('warn', `could not migrate ${PEOPLE_FILE}: ${errorText(error)}`);
    }
  }

  /**
   * 追加或覆盖一个记忆文件。
   *
   * 顺序是「先校验大小、再写盘」：写一半才发现超限会留下一个半截文件（记忆文件是
   * 摘要 Agent 下一次开工要读的输入，半截比不写更坏）。写走 `writeMemoryFile` 的
   * 串行队列 —— 同一个文件的两次写入可能来自同一轮里的两个并行工具调用。
   *
   * `exec` 只用来判断「这次写是不是私聊发起的」（见 `assertGlobalWrite`）；内部调用
   * （存表情包的目录、滚档）不带它，因此不受闸门影响。
   * @param relative - 记忆目录内的相对路径。
   * @param text - 要写入的 markdown。
   * @param append - true = 追加，false = 覆盖。
   * @returns 工具输出。
   */
  async function writeMemoryFile(relative, text, append, { force = false, exec } = {}) {
    assertGlobalWrite(relative, exec);
    const absolute = join(memoryBase, relative);
    const maxBytes = Math.max(256, Math.floor(Number(settings.memoryFileMaxBytes) || 0));
    const previousRaw = (await readTextOrUndefined(absolute)) ?? '';
    const previousBytes = Buffer.byteLength(previousRaw, 'utf8');
    const isCognition = relative === COGNITION_FILE;
    const isStickers = relative === STICKERS_FILE;
    const isPeople = relative === PEOPLE_FILE;
    const isMemory = relative.endsWith('MEMORY.md');
    // 1) 落盘前归一化：重复二级标题只留一个、同键条目只留最后一条。
    //    写在**写入路径**而不是读路径：读要如实反映磁盘上到底有什么，否则人看不出问题。
    let next = append
      ? `${previousRaw.replace(/\s*$/, '')}\n${text.replace(/\s+$/, '')}\n`
      : `${text.replace(/\s+$/, '')}\n`;
    if (isCognition) next = normalizeCognitionDoc(next);
    else if (isStickers) next = normalizeStickerDoc(next);
    // 2) 护栏：整份重写把条目数砍掉一大截就拒绝。模型漏抄几行是这类文件最常见的破坏方式，
    //    而它自己完全不会察觉（文件「写成功了」）。确实要精简时用 force。
    if (!append && (isCognition || isStickers || isPeople || isMemory)) {
      const countOf = (value) => {
        if (isCognition) return parseCognition(value).entries.length;
        if (isStickers) return parseStickerCatalog(value).collected.length + parseStickerCatalog(value).pending.length;
        if (isPeople) return parsePeopleDoc(value).records.length;
        return parseMemoryDoc(value, { file: relative }).records.length;
      };
      const before = countOf(previousRaw);
      const after = countOf(next);
      // 护栏对**所有结构化文件**生效：整份重写漏抄几行是模型最常见的破坏方式，而它
      // 完全不会察觉（文件「写成功了」）。确实要精简时用 force。
      if (!force && before > 0 && after < Math.ceil(before * 0.9)) {
        throw new Error(
          `qq_memory: this write would keep only ${after} of ${before} entries in ${memoryLabel}/${relative} — ` +
            'rewrite it keeping every row (or pass force: true if the reduction is intentional). ' +
            'Add or update single rows with action "upsert" instead of rewriting the whole file.',
        );
      }
    }
    const bodyBytes = Buffer.byteLength(next, 'utf8');
    if (bodyBytes > maxBytes) {
      throw new Error(
        `qq_memory: ${bodyBytes} bytes exceeds memoryFileMaxBytes (${maxBytes}) — ` +
          `\`${memoryLabel}/${relative}\` is already ${previousBytes} bytes. ` +
          'Rewrite it shorter with action "write" (keep only what still matters), or put the new fact in a different file.',
      );
    }
    // 3) 写前留一份历史：模型整份重写时写坏，至少还能翻回上一版（只留最近 20 份）。
    if (previousBytes > 0 && relative.endsWith('.md')) await backupMemoryFile(relative, previousRaw);
    const queueKey = absolute;
    const previous = memoryWrites.get(queueKey) ?? Promise.resolve();
    const done = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(absolute), { recursive: true });
        await writeTextAtomic(absolute, next);
      });
    memoryWrites.set(queueKey, done);
    await done;
    // 热层写完之后看一眼要不要滚档：先写 archive、成功才重写热层（见 rolloverMemory）。
    const convKey = conversationKeyForRelative(relative);
    if (convKey !== undefined && settings.memoryArchive) {
      archiveMonthsCache.delete(convKey);
      void rolloverMemory(convKey, { reason: 'write' }).catch((error) => {
        report('warn', `memory rollover after writing ${relative} failed: ${errorText(error)}`);
      });
    }
    return {
      action: append ? 'append' : 'write',
      path: `${memoryLabel}/${relative}`,
      bytes: bodyBytes,
      lines_total: next.split('\n').length,
      returned: 1,
      truncated: false,
      note: append ? `appended ${bodyBytes} bytes` : `replaced ${previousBytes} bytes with ${bodyBytes} bytes`,
    };
  }

  /** `conversations/<slug>/MEMORY.md` → 会话 key（认不出来时 undefined）。 */
  function conversationKeyForRelative(relative) {
    const match = /^conversations\/([^/]+)\/MEMORY\.md$/.exec(String(relative ?? ''));
    if (match === null) return undefined;
    for (const key of memorySlugs.keys()) {
      if (memorySlugFor(key) === match[1]) return key;
    }
    return undefined;
  }

  /**
   * 写入前把旧内容复制进 `<memory>/.history/`，同一个文件只留最近 `HISTORY_KEEP` 份。
   *
   * 为什么要它：`qq_memory write` 是整份覆盖，模型漏抄几行这种事故**没有任何提示**；
   * 有历史至少能人工翻回去。备份失败绝不挡正常写入 —— 记忆写成功比备份重要。
   */
  async function backupMemoryFile(relative, text) {
    const dir = join(memoryBase, '.history');
    const flat = relative.replace(/[\\/]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await mkdir(dir, { recursive: true });
      await writeTextAtomic(join(dir, `${flat}.${stamp}.md`), text);
      const kept = (await readdirOrEmpty(dir)).filter((name) => name.startsWith(`${flat}.`)).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - HISTORY_KEEP))) await unlink(join(dir, old)).catch(() => {});
    } catch (error) {
      report('warn', `could not back up ${memoryLabel}/${relative}: ${errorText(error)}`);
    }
  }

  /**
   * 写入或更新单条记忆（`qq_memory` 的 upsert）。
   *
   * 这是「不要让模型整份重写 markdown」的正解：它只给字段，格式、分节、去重都由
   * 纯函数负责（`cognition.js` 的 `upsertCognitionRow` / `upsertStickerRow`，
   * `memory-select.js` 的 `upsertMemoryRow` / `upsertPersonRow`）。
   *
   * 四个文件、四种键：认知库按**文字写法**，表情包目录按**收藏名**，`MEMORY.md` 按
   * **主题**，`PEOPLE.md` 按 **QQ 号 / 名字**。私聊的闸门在 `writeMemoryFile`。
   * @param relative - 记忆目录内的相对路径。
   * @param entry - 字段集合。
   * @param exec - 工具执行上下文（只用于私聊写入闸门）。
   * @returns 工具输出。
   */
  async function upsertMemoryEntry(relative, entry, exec) {
    assertGlobalWrite(relative, exec);
    const current = (await readTextOrUndefined(join(memoryBase, relative))) ?? '';
    let result;
    if (relative === STICKERS_FILE) {
      result = upsertStickerRow(current, {
        name: entry?.name,
        look: entry?.look,
        meaning: entry?.meaning,
        scene: entry?.scene,
        path: entry?.image,
        date: entry?.date,
        confidence: entry?.confidence,
      });
    } else if (relative === COGNITION_FILE) {
      result = upsertCognitionRow(current, {
        writeup: entry?.name,
        meaning: entry?.meaning,
        usage: entry?.usage,
        source: entry?.source,
        date: entry?.date,
        confidence: entry?.confidence,
        variants: String(entry?.variants ?? '').split(/[\/／、,，]/).map((item) => item.trim()).filter((item) => item.length > 0),
        type: entry?.type,
      });
    } else if (relative === PEOPLE_FILE) {
      result = upsertPersonRow(current, {
        name: entry?.name,
        qq: entry?.qq,
        aliases: String(entry?.aliases ?? '').split(/[\/／、,，]/).map((item) => item.trim()).filter((item) => item.length > 0),
        note: entry?.meaning,
        date: entry?.date,
        confidence: entry?.confidence,
      });
    } else if (relative.endsWith('MEMORY.md')) {
      result = upsertMemoryRow(current, {
        topic: entry?.name,
        text: entry?.meaning,
        section: entry?.section,
        kind: entry?.kind,
        date: entry?.date,
        confidence: entry?.confidence,
        expires: entry?.expires,
        pinned: entry?.pinned === true,
      });
    } else {
      throw new Error('qq_memory: action "upsert" works on COGNITION.md, STICKERS.md, PEOPLE.md and */MEMORY.md (use "append" for other files)');
    }
    const written = await writeMemoryFile(relative, result.text, false, { force: true, exec });
    // 目录/热梗是每轮提示词的一部分：立刻失效缓存，别等 TTL。
    catalogCache = { at: 0, key: '', text: catalogCache.text };
    const needle = String(entry?.name ?? '').trim();
    return {
      ...written,
      action: 'upsert',
      path: `${memoryLabel}/${relative}`,
      note: `${result.replaced ? 'replaced' : 'added'} in «${result.section}»`,
      text: result.text.split(/\r?\n/).find((line) => needle.length > 0 && line.includes(needle)) ?? '',
    };
  }

  /**
   * 删掉单条记忆（`qq_memory` 的 remove）。
   * @param relative - 认知库 / 表情包目录 / 人物表 / 会话热层。
   * @param name - 认知条目的写法 / 表情包的名字 / 记忆主题 / 人物名。
   * @param exec - 工具执行上下文（只用于私聊写入闸门）。
   * @returns 工具输出。
   */
  async function removeMemoryEntry(relative, name, exec) {
    assertGlobalWrite(relative, exec);
    const current = (await readTextOrUndefined(join(memoryBase, relative))) ?? '';
    const result = relative === STICKERS_FILE
      ? removeStickerRow(current, name)
      : relative === COGNITION_FILE
        ? removeCognitionRow(current, name)
        : relative === PEOPLE_FILE
          ? removePersonRow(current, name)
          : relative.endsWith('MEMORY.md')
            ? removeMemoryRow(current, name)
            : (() => { throw new Error('qq_memory: action "remove" works on COGNITION.md, STICKERS.md, PEOPLE.md and */MEMORY.md'); })();
    if (!result.removed) {
      return { action: 'remove', path: `${memoryLabel}/${relative}`, bytes: Buffer.byteLength(current, 'utf8'), lines_total: current.split('\n').length, returned: 0, truncated: false, note: `no entry named «${String(name ?? '').trim()}»` };
    }
    const written = await writeMemoryFile(relative, result.text, false, { force: true, exec });
    catalogCache = { at: 0, key: '', text: catalogCache.text };
    return { ...written, action: 'remove', path: `${memoryLabel}/${relative}`, note: `removed «${String(name ?? '').trim()}»` };
  }

  /**
   * 给表情包目录里的一条改名字（`qq_rename_sticker` 更新 `STICKERS.md` 的那一半）。
   *
   * 文件改名由 `index.js` 的 `renameSticker` 做（它才知道 `stickerRoot`），这里只管目录：
   * 按旧名字找到那条，把画面 / 含义 / 场景 / 日期 / 置信整行搬到新名字下，旧行删掉 ——
   * 模型只给「改成什么」，字段由纯函数搬运，改个名字不会把含义改丢。
   *
   * 新名字本来就有条目时照样按**旧名字**那一条搬：这等于把两张合并成一张（旧名字是
   * 要消失的那一个），所以不需要额外护栏。旧名字不存在时只追加一条新的，`renamed` 说清。
   *
   * @param {object} input - `{ from, to, path, meaning?, scene?, look?, date?, confidence? }`。
   * @returns `{ ok, renamed, section }`：写盘失败时 `ok: false` + `reason`（调用方回滚文件改名）。
   */
  async function renameStickerEntry({ from, to, path, meaning, scene, look, date, confidence } = {}) {
    if (!memoryEnabled) return { ok: false, reason: 'memory is disabled' };
    const current = (await readTextOrUndefined(join(memoryBase, STICKERS_FILE))) ?? '';
    let result;
    try {
      result = renameStickerRow(current, from, { name: to, path, meaning, scene, look, date, confidence });
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    try {
      await writeMemoryFile(STICKERS_FILE, result.text, false, { force: true });
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
    // 目录是每轮提示词的一部分：立刻失效缓存，下一轮就该看到新名字。
    catalogCache = { at: 0, key: '', text: catalogCache.text };
    return { ok: true, renamed: result.renamed, section: result.section };
  }

  /** 一条转录记录在工具结果里的一行文本。 */
  function describeTranscriptLine(line) {    if (line.conversation !== undefined) return `[${line.date ?? '?'}] ${line.conversation} — ${line.messages ?? 0} 条，最后 ${line.last_at ?? '?'} ${line.last_text ?? ''}`.trim();
    const tags = [];
    if (line.kind !== undefined) tags.push(line.kind);
    if (line.addressed === true) tags.push('被叫到');
    if (line.command !== undefined) tags.push(`指令:${line.command}`);
    if (line.media === true) tags.push('带图');
    const tag = tags.length > 0 ? `[${tags.join(' ')}] ` : '';
    return `${line.at ?? ''} ${tag}${line.user ?? '?'}: ${line.text ?? ''}`.trim();
  }

  /** 转录工具共享的参数上限。 */
  function transcriptLimit(raw, fallback) {
    const value = Math.floor(Number(raw) || 0);
    if (value > 0) return Math.min(value, 2000);
    return fallback;
  }

  /** `qq_transcript list`：磁盘上有记录的会话、条数与最后一条消息。 */
  async function listTranscripts() {
    const lines = [];
    const root = join(memoryBase, 'conversations');
    for (const slug of await readdirOrEmpty(root)) {
      const dir = join(root, slug);
      const files = (await readdirOrEmpty(join(dir, 'log'))).filter((name) => name.endsWith('.jsonl')).sort();
      if (files.length === 0) continue;
      let messages = 0;
      let newest;
      for (const name of files) {
        const records = await readJsonl(join(dir, 'log', name));
        messages += records.length;
        for (const record of records) {
          if (newest === undefined || (Number(record.at) || 0) > (Number(newest.at) || 0)) newest = record;
        }
      }
      let meta;
      try {
        meta = JSON.parse((await readTextOrUndefined(join(dir, 'meta.json'))) ?? '{}');
      } catch {
        meta = {};
      }
      lines.push({
        conversation: String(meta.key ?? slug),
        name: String(meta.name ?? ''),
        date: `${files[0]} → ${files[files.length - 1]}`,
        messages,
        last_at: newest === undefined ? '' : localStamp(newest.at),
        last_text: newest === undefined ? '' : String(newest.text ?? '').slice(0, 80),
      });
    }
    // 最近活跃的排在前面：摘要时第一眼该看到有人在说话的群。
    lines.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
    return { action: 'list', lines, returned: lines.length, truncated: false };
  }

  /**
   * `qq_transcript read`：读一个会话的转录。
   * @param target - `{ key, slug, label }`。
   * @param args - 工具参数（`date` / `since` / `until` / `limit`）。
   */
  async function readTranscript(target, args) {
    const dir = join(memoryBase, 'conversations', target.slug, 'log');
    const available = (await readdirOrEmpty(dir)).filter((name) => name.endsWith('.jsonl')).sort();
    const limit = transcriptLimit(args.limit, 200);
    const day = typeof args.date === 'string' ? args.date.trim() : '';
    const from = typeof args.since === 'string' ? args.since.trim() : '';
    const to = typeof args.until === 'string' ? args.until.trim() : '';
    const inRange = (name) => {
      const date = name.replace(/\.jsonl$/, '');
      if (day.length > 0) return date === day;
      if (from.length > 0 && date < from) return false;
      if (to.length > 0 && date > to) return false;
      return true;
    };
    const wanted = available.filter(inRange);
    const records = [];
    for (const name of wanted) records.push(...await readJsonl(join(dir, name)));
    records.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    // 超限时保留**最近**的那些：问「刚刚/后来怎么样了」远多于问「最开始是什么」。
    const truncated = records.length > limit;
    const kept = truncated ? records.slice(records.length - limit) : records;
    return {
      action: 'read',
      conversation: target.key,
      returned: kept.length,
      truncated,
      note: truncated ? `只给了最近 ${kept.length} 条（共 ${records.length} 条）` : '',
      lines: kept.map((record) => ({
        at: localStamp(record.at),
        user: String(record.name ?? record.user ?? '?'),
        text: String(record.text ?? ''),
        kind: String(record.kind ?? ''),
        addressed: record.addressed === true,
        command: record.command === undefined ? undefined : String(record.command),
        media: record.hasMedia === true,
      })),
    };
  }

  /**
   * `qq_transcript search`：在某个会话的转录里按子串找（文本、昵称、日期都算）。
   * @param target - `{ key, slug, label }`。
   * @param args - 工具参数（`query` / `limit`）。
   */
  async function searchTranscript(target, args) {
    const dir = join(memoryBase, 'conversations', target.slug, 'log');
    const limit = transcriptLimit(args.limit, Math.max(1, Math.floor(Number(settings.memorySearchHits) || 40)));
    const needle = String(args.query).trim().toLowerCase();
    const hits = [];
    for (const name of (await readdirOrEmpty(dir)).filter((file) => file.endsWith('.jsonl')).sort().reverse()) {
      for (const record of await readJsonl(join(dir, name))) {
        const haystack = `${record.text ?? ''}\n${record.name ?? ''}\n${record.date ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        hits.push({
          at: localStamp(record.at),
          user: String(record.name ?? record.user ?? '?'),
          text: String(record.text ?? ''),
          kind: String(record.kind ?? ''),
          addressed: record.addressed === true,
          media: record.hasMedia === true,
        });
      }
    }
    hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const kept = hits.slice(0, limit);
    return {
      action: 'search',
      conversation: target.key,
      returned: kept.length,
      truncated: hits.length > kept.length,
      note: hits.length > kept.length ? `共 ${hits.length} 条命中，只给了最新的 ${kept.length} 条` : '',
      lines: kept,
    };
  }

  /**
   * 记忆文件的展示路径（相对 cwd）：工具返回值里给模型看的永远是这一种写法，
   * 它同时也是 `qq_memory` 下次调用时该回传的 `path`。
   * @param slug - 会话目录名。
   * @param file - 会话目录内的文件名。
   * @returns 形如 `.qq-memory/conversations/group-123/MEMORY.md`。
   */
  function memoryRelativeConvPath(slug, file) {
    return `${memoryLabel}/conversations/${slug}/${file}`;
  }

  /**
   * 解析工具调用「在说哪个会话」，并给出它的记忆目录。
   *
   * 两条来源，按优先级：
   *   1. 调用它的那个 Agent 就是某个 QQ 会话的 Agent（`exec.agent.id` → 会话 key）；
   *   2. 显式给的 `conversation`（`group:100000001` / `private:100000002`）——
   *      摘要会话不是任何 QQ 会话的 Agent，必须走这条。
   *
   * 显式给的名字会先按「已见过的会话」核对：记忆目录是按 key 派生目录名的，一个
   * 拼错的 key 会安静地开出一个新的空目录，看起来就像「记忆丢了」。核对不上就报错。
   *
   * @param args - 工具参数（可能带 `conversation`）。
   * @param exec - 工具执行上下文（`exec.agent.id`）。
   * @param tool - 工具名，只用于报错。
   * @returns `{ key, slug, label, memoryFile }`；无法确定时抛错。
   */
  function resolveMemoryConversation(args, exec, tool) {
    if (!memoryEnabled) throw new Error(`${tool} is unavailable: long-term memory is disabled (qq-bridge config memory/memoryDir)`);
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const explicit = String(args?.conversation ?? '').trim();
    let conversation = fromAgent;
    if (explicit.length > 0) {
      // 容忍「裸群号」这类写法：权威格式是 `group:<id>` / `private:<id>`，其余尽量往
      // 已知会话上靠；靠不上且本来就不是 key 形态时报错，而不是开一个新目录。
      const known = explicit.includes(':') ? explicit : [...conversations.keys()].find((key) => key.endsWith(`:${explicit}`));
      conversation = known !== undefined ? conversations.get(known) : undefined;
      if (conversation === undefined && !explicit.includes(':')) {
        throw new Error(`${tool}: unknown conversation "${explicit}"; use a key like "group:123456" (see qq_transcript list)`);
      }
    }
    const key = conversation?.key ?? explicit;
    if (key.length === 0) {
      throw new Error(`${tool}: cannot tell which conversation this is about; pass conversation: "group:<群号>" or "private:<QQ号>"`);
    }
    const paths = memoryPaths(key);
    const label = conversation !== undefined
      ? `${conversation.type === 'group' ? '群' : '私聊'} ${conversation.name || conversation.id}`
      : key;
    return { key, slug: paths.slug, label, memoryFile: paths.memoryFile };
  }

  /**
   * 记忆工具到底能不能用：开关开着，并且没有被 `allowTools` 挡在外面。
   *
   * 白名单是使用者的明确意图（「只给 read」），提示词里推荐一个被挡掉的工具会让模型
   * 去撞一次「工具不存在」；记忆相关的提示、索引注入都跟着这个判定走。
   * @returns 两个记忆工具都可见时为 true。
   */
  function memoryToolsAllowed() {
    if (!memoryEnabled) return false;
    if (allowTools.length === 0) return true;
    return allowTools.includes('qq_memory') && allowTools.includes('qq_transcript');
  }

  /**
   * 摘要 Agent 的系统提示：不放人格，只放规矩与「今天要处理哪个会话」。
   *
   * 这里的措辞跟着长期记忆 v2 走了（见 docs/memory.md「定时摘要怎么跑」）：摘要只判断
   * 「这条新不新、真不真」，不再让它维护一个长度上限 —— 长度由滚档（archive）负责，
   * 写不出来时选择「不写」比硬编一句可靠。
   * @param notice - `{ key, label, slug, type, since, until, queue }`。
   * @returns 系统提示小节正文。
   */
  function digestPrompt(notice) {
    if (notice === undefined) {
      return [
        '## 记忆维护会话',
        '',
        '你不是在跟任何人聊天。这个会话只有一个用途：在后台把 QQ 群的聊天记录整理成',
        `长期记忆，写进 \`${memoryLabel}/\` 里的 Markdown 文件。你写的字不会发给任何人，也不会有人回复你。`,
        '',
        `- 永远先加载 \`message-digest\` skill（\`skill\` 工具，名字就叫 message-digest），按它写的流程做。`,
        `- 只写 \`${memoryLabel}/\` 里的文件，用 \`qq_memory\` 工具写；不要试图写别的位置。`,
        '- 没有实质内容就什么都不写，回一句「无事」即可 —— 空摘要比编造的摘要好。',
      ].join('\n');
    }
    const isPrivate = notice.type === 'private';
    return [
      '## 记忆维护会话',
      '',
      '你不是在跟任何人聊天。这个会话只有一个用途：在后台把 QQ 群的聊天记录整理成',
      `长期记忆，写进 \`${memoryLabel}/\` 里的 Markdown 文件。你写的字不会发给任何人，也不会有人回复你。`,
      '',
      `本轮要处理的会话：**${notice.label}**（\`${notice.key}\`，目录 \`${memoryLabel}/conversations/${notice.slug}/\`），`,
      `时间窗：${notice.since} 之后到 ${notice.until}（本地时间）为止。`,
      '',
      '做法：',
      `1. 用 \`skill\` 工具加载 \`message-digest\` skill，按它写的流程做（它是这一步的准绳）。`,
      `2. 用 \`qq_transcript\` 读这个会话在这个时间窗里的记录${notice.queue && notice.queue.length > 0 ? `；本批还有其它会话排队（${notice.queue.join('、')}），它们各有自己的一轮，不用在这里处理` : ''}。`,
      `3. 写 \`conversations/${notice.slug}/MEMORY.md\` 时用 \`qq_memory\` 的 **upsert**，一次一条：\`name\` 是主题（例如 \`kaguya\`、\`周五固定开黑\`），\`meaning\` 是一句话事实，\`section\` 是 人 / 惯例与偏好 / 在追 / 事实与事件 之一，能确定日期就带 \`date\`（YYYY-MM-DD）。同一个主题再出现时 upsert 会原地替换，不会重复。**不要整份重写 MEMORY.md**，也不要为了控制长度删掉还成立的事实 —— 文件太长时会由插件自动滚档到 \`archive/\`，冷层仍然搜得到。`,
      `4. 人物单独维护：用 \`qq_memory\` 的 upsert 写 \`${PEOPLE_FILE}\`（\`name\` 是名字，\`qq\` 是 QQ 号，\`aliases\` 是别名，\`meaning\` 是一句话的「这个人的角色 / 跟群的关系」）。人物表是**全局**的，一个群十几个人也就几行。`,
      `5. 遇到新东西先分诊：**只有文字**的梗 / 黑话 / 谐音走 \`learn-meme\` skill 写 \`COGNITION.md\`；**有图**的表情包走 \`learn-sticker\` skill（先收藏再写 \`STICKERS.md\`）；图文都有就两边互相写名字，不要在一个文件里写两遍。`,
      `6. 严格止步于 \`${memoryLabel}/\` 之内：不要读源码、不要改仓库里任何其它文件、不要发 QQ 消息。`,
      '',
      // 隐私边界（设计 §4）：这不是「尽量不要」，是写通道直接拒绝 —— 这里先说清楚，
      // 让它一开始就别走错路。
      isPrivate
        ? `**这是私聊。** 私聊里知道的事只能写进 \`conversations/${notice.slug}/MEMORY.md\`：\`COGNITION.md\` 与 \`PEOPLE.md\` 是全局的，私聊的摘要轮**写不进去**（工具会直接拒绝）。确实是公共知识（网上查到的、别的群也这么用）的，从公开来源写，不要从这段私聊里提上去。`
        : `**scope 规则：** 这个人 / 这件事只在这个群成立 → 写本群 \`MEMORY.md\`；公共的梗、公开的信息才进全局的 \`COGNITION.md\` / \`PEOPLE.md\`。私聊里知道的事永远不要写进全局文件（工具会拒绝，这里是同一件事）。`,
      '',
      '如果这个时间窗里没有值得一提的内容，就什么都不写，回一句「无事」即可 —— 空摘要比编造的摘要好。',
    ].join('\n');
  }

  /**
   * 真正跑一轮摘要 Agent：把一条 user message 交给它，等这一轮结束（带硬超时）。
   *
   * `digestTarget` 在这一轮里指向被摘要的会话 —— 私聊写入闸门靠它判断「这次写是不是
   * 从私聊的摘要轮发起的」（摘要 Agent 不在 `sessionIndex` 里）。
   * @param notice - 见 {@link digestPrompt}。
   * @param text - 这一轮要它做的事（转录窗口 / 周合并指令）。
   * @returns 消耗的字符数，供日志用。
   */
  async function runDigestTurn(notice, text) {
    // 摘要 Agent 会被 resume 复用；提示词里「这一轮要处理哪个会话」必须跟着改，
    // 否则第二个会话的摘要轮会看到第一个会话的名字（提示词是创建时注册的 provider）。
    digestNotice = notice;
    const agent = await ensureDigestAgent(notice);
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    const previousTarget = digestTarget;
    digestTarget = notice?.key;
    try {
      agent.followup(message);
      const timeoutMs = Math.max(1000, Math.floor(Number(settings.digestTimeoutMs) || 0));
      let timer;
      const timeout = new Promise((resolve) => {
        // ctx.timeout 把定时器挂在当前 fiber 上，插件卸载时自动清掉；它返回 disposer。
        timer = typeof ctx.timeout === 'function' ? ctx.timeout(() => resolve('timeout'), timeoutMs) : setTimeout(() => resolve('timeout'), timeoutMs);
        timer?.unref?.();
      });
      const outcome = await Promise.race([agent.whenIdle?.().then(() => 'idle') ?? Promise.resolve('idle'), timeout]);
      if (typeof timer === 'function') timer();
      else clearTimeout(timer);
      if (outcome === 'timeout') {
        // 卡住的 turn 不该把摘要永久堵死：销毁这个 Agent，下一次重新开一个（转录还在磁盘上）。
        report('warn', `digest for ${notice.key} timed out after ${timeoutMs}ms; disposing the digest agent`);
        try {
          await digestHandle?.dispose();
        } catch (error) {
          report('warn', `could not dispose the digest agent: ${errorText(error)}`);
        }
        digestHandle = undefined;
        throw new Error(`digest timed out after ${timeoutMs}ms`);
      }
    } finally {
      digestTarget = previousTarget;
    }
  }

  /** 摘要本身：把转录窗口交给摘要 Agent，等这一轮结束。 */
  async function runDigest(notice) {
    return runDigestTurn(notice, notice.instruction);
  }

  /**
   * 周合并（`digestConsolidate`，默认关）：摘要之后的第二次调用，只整理不新增事实。
   *
   * 为什么值得单独一次：摘要那一轮在「这批又发生了什么」，让它同时维护人物 one-liner、
   * 合并重复事实、清过期计划，它就会顾此失彼（设计 §6.3）。这里只给整理指令，写还是
   * 走同样的 `qq_memory` upsert / remove。
   */
  async function runConsolidate(notice) {
    const isPrivate = notice.type === 'private';
    const instruction = [
      `整理 ${notice.label}（\`${notice.key}\`）的记忆，不新增事实、只做聚合：`,
      isPrivate
        ? `1. 只读 \`conversations/${notice.slug}/MEMORY.md\`（这是私聊：不要碰 \`${PEOPLE_FILE}\` / \`COGNITION.md\`，写了会被拒绝）。`
        : `1. 读 \`conversations/${notice.slug}/MEMORY.md\` 与 \`${PEOPLE_FILE}\`。`,
      '2. 合并重复的条目（同一件事写了两遍 → 留一条更完整的）；把还成立的「在追 / 在做」的日期刷新一下；已经明确过期的计划用 `qq_memory` 的 remove 删掉。',
      isPrivate
        ? '3. 私聊里的人物 / 偏好留在本会话的 `MEMORY.md` 里，不要写全局人物表。'
        : `3. 人物表里这个会话相关的人，把 \`meaning\` 那一句 one-liner 刷新成最新、最短的版本。`,
      '4. 改动用 `qq_memory` 的 upsert / remove 逐条做，**不要整份重写**；没有可整理的就什么都不写。',
    ].join('\n');
    await runDigestTurn(notice, instruction);
  }

  /**
   * 扫描所有会话，把「今天该摘要」的排进串行队列。
   *
   * 每天在 `digestAtHour` 点醒一次，所以判据不是「距上次多久」而是**日期**：这条会话
   * 今天已经摘要过就跳过（记在 `digest.json` 里的日期，重启也不会在同一天重复摘要，
   * 比「距上次 ≥ N 小时」稳）。外加一条 `digestMinLines`：今天没攒够新消息就留到明天
   * —— 为一两句话白跑一次模型调用不值得，消息也不会丢（dirty 计数按天累加）。
   */
  function runDigestSweep() {
    if (!memoryEnabled) return;
    digestChain = digestChain
      .then(async () => {
        // 状态都不必现读磁盘：`memoryLastDigest` 在启动时从 `digest.json` 预热、每次
        // 摘要成功后就地更新；`memoryDirty` 是本进程攒的计数（重启归零，靠日期重新算）。
        const today = localDate();
        const minLines = Math.max(1, Math.floor(Number(settings.digestMinLines) || 1));
        const queue = [];
        for (const conversation of conversations.values()) {
          if (digestQueued.has(conversation.key)) continue;
          const lastDigestAt = memoryLastDigest.get(conversation.key) ?? 0;
          // 今天已经摘要过：同一个会话一天至多一次。
          if (lastDigestAt > 0 && localDate(lastDigestAt) === today) continue;
          const dirty = memoryDirty.get(conversation.key) ?? 0;
          // 攒够新消息才值得跑一次模型调用：没攒够就留到明天，消息不会丢
          // （dirty 计数一直累加，明天的窗口里还是它们）。
          if (dirty < minLines) continue;
          queue.push({ conversation, since: lastDigestAt });
        }
        for (const item of queue) {
          // 排进队列这一刻就把 dirty 清零：这一轮之后无论成败，都不该把同一批消息再喂一遍
          // （失败的时间戳不会推进，明天的摘要会把它们连同新消息一起补上）。
          memoryDirty.set(item.conversation.key, 0);
          void enqueueDigest(item.conversation, item.since);
        }
      })
      .catch((error) => {
        report('warn', `digest sweep failed: ${errorText(error)}`);
      });
  }

  /**
   * 把一个会话的摘要任务挂到串行链尾；完成后记一次状态。
   * @param conversation - 目标会话。
   * @param since - 上一次摘要的时间戳（0 = 头一次）。
   */
  function enqueueDigest(conversation, since) {
    digestQueued.add(conversation.key);
    digestChain = digestChain
      .then(async () => {
        const paths = memoryPaths(conversation.key);
        // 先把已经排队的转录落盘等干净：转录是**后台**追加的（不挡事件热路径），而
        // 「补课」这条路是收到消息后立刻触发的 —— 不等的话会读到一个还没写出来的日志
        // 目录，摘要就被静默跳过了（消息不会丢，但要等到明天的摘要点）。
        await Promise.all(writesFor(paths.logDir));
        const files = (await readdirOrEmpty(paths.logDir)).filter((name) => name.endsWith('.jsonl')).sort();
        // 多读一天：跨越午夜时「今天」和「昨天」两个文件都要，靠 at 时间戳再筛一次。
        const cutoff = since > 0 ? since - 24 * 60 * 60 * 1000 : 0;
        const lines = [];
        for (const name of files) {
          for (const line of await readJsonl(join(paths.logDir, name))) {
            if ((Number(line.at) || 0) >= cutoff) lines.push(line);
          }
        }
        lines.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
        const window = lines.filter((line) => (Number(line.at) || 0) > since);
        if (window.length === 0) return;
        const budget = Math.max(1000, Math.floor(Number(settings.digestMaxChars) || 0));
        const rendered = renderTranscriptWindow(window, budget);
        if (rendered.included === 0) return;
        const until = new Date().toLocaleString('zh-CN', { hour12: false });
        const label = `${conversation.type === 'group' ? '群' : '私聊'} ${conversation.name || conversation.id}`;
        const header = rendered.dropped > 0
          ? `本批共 ${window.length} 条（${new Date(since || window[0].at).toLocaleString('zh-CN', { hour12: false })} 起），为了让这次摘要放得下，只给了你**最近**的 ${rendered.included} 条，更早的 ${rendered.dropped} 条这次没给（它们大多在上一次摘要里已经处理过了）。\n\n`
          : `本批共 ${window.length} 条。\n\n`;
        const instruction =
          `处理 ${label} 的聊天记录：${conversation.key}\n` +
          `（窗口起点：${since > 0 ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '首次摘要，看你能拿到的全部'}）\n\n` +
          `${header}${rendered.text}`;
        report('info', `digest ${conversation.key}: ${rendered.included}/${window.length} lines, ${rendered.text.length} chars`);
        const notice = {
          key: conversation.key,
          label,
          slug: paths.slug,
          type: conversation.type,
          since: since > 0 ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '（此前没有摘要）',
          until,
          queue: [...digestQueued].filter((key) => key !== conversation.key),
          instruction,
        };
        await runDigest(notice);
        // 滚档与周合并都在摘要**成功之后**做：摘要失败时不推进状态、也不动文件。
        // 顺序也是刻意的：先滚档（机械规则），再整理（模型判断）—— 整理看到的是已经
        // 落进冷层之后的热层，不会把刚滚走的条目又写回来。
        if (settings.digestRollover) await rolloverMemory(conversation.key, { reason: 'digest' });
        if (settings.digestConsolidate) {
          // 周合并只是「让文件更整齐」，它失败不该把一轮成功的摘要判成失败
          // （否则 digest.json 不推进，明天会把同一批转录再摘要一遍）。
          try {
            await runConsolidate(notice);
          } catch (error) {
            report('warn', `consolidation for ${conversation.key} failed (the digest itself succeeded): ${errorText(error)}`);
          }
        }
        const state = await readDigestState();
        const finishedAt = Date.now();
        memoryLastDigest.set(conversation.key, finishedAt);
        state.conversations[conversation.key] = {
          ...(state.conversations[conversation.key] ?? {}),
          // `at` 与 `date` 都要写：`date` 是「今天摘要过没有」的判据（本地日界线），
          // `at` 是转录窗口的起点。两份都在，读的时候就不必再换算时区。
          lastDigestAt: finishedAt,
          lastDigestDate: localDate(finishedAt),
          lastLines: window.length,
          lastLabel: label,
        };
        await writeDigestState(state);
      })
      .catch((error) => {
        report('warn', `digest for ${conversation.key} failed: ${errorText(error)}`);
      })
      .finally(() => {
        digestQueued.delete(conversation.key);
      });
  }

  /**
   * 摘要循环的生命周期：每天 `digestAtHour` 点醒一次，醒来跑完摘要再排下一次。
   *
   * 用 `ctx.interval`（dsh-base 的 timer 服务）而不是裸 setInterval：定时器挂在当前
   * fiber 上，插件卸载时自动清掉，不会留下一个还在跑的摘要循环。测试用的 Host 桩
   * 没有 timer 服务，所以有裸 setInterval 的退路。
   */
  function startDigestTimer() {
    const atHour = settings.digestAtHour;
    const tick = () => {
      try {
        runDigestSweep();
      } catch (error) {
        report('warn', `digest sweep threw: ${errorText(error)}`);
      }
    };
    // 预热：把落盘的摘要时间读进内存，`runDigestSweep` 才能判断「今天这条会话摘要过没有」。
    // 注意**不**在这里立刻扫一遍：`conversations` 是运行时状态，此刻还是空的，扫也扫不到
    // 任何东西。真正需要补的那次由 `maybeCatchUpDigest` 在第一条消息到达时触发。
    void (async () => {
      try {
        const state = await readDigestState();
        for (const [key, entry] of Object.entries(state.conversations)) {
          const at = Number(entry?.lastDigestAt) || 0;
          if (at > 0) memoryLastDigest.set(key, at);
        }
        report('info', `memory: ${memoryLastDigest.size} conversation(s) with a previous digest`);
      } catch (error) {
        report('warn', `could not load digest state: ${errorText(error)}`);
      }
      // 派生索引（hits / lastSeen）与人物表迁移也在启动时并行预热：
      //   - 统计读到之前 `recallText` 会把 salience 当 0（降级，不抛错）；
      //   - 迁移只补不覆盖、幂等，跑一次就够。
      await loadStats();
      await migratePeopleDoc();
    })();
    let digestTimerDisposer;
    ctx.effect(() => {
      // 每天醒一次，醒来跑完摘要再排下一次：每次算的都是「距离下一个整点还有多久」，
      // 所以刚过点时会排到明天，不会在同一个点上反复醒。
      const schedule = () => {
        const wait = msUntilDailyHour(atHour);
        if (typeof ctx.interval === 'function') {
          digestTimerDisposer = ctx.interval(() => {
            digestTimerDisposer?.();
            tick();
            schedule();
          }, wait);
          return;
        }
        // 没有 timer 服务（例如测试桩或最小组合）时退回裸定时器：同样是「跑完再排」，
        // 不是固定周期。
        const handle = setTimeout(() => {
          tick();
          schedule();
        }, wait);
        handle.unref?.();
        digestTimerDisposer = () => clearTimeout(handle);
      };
      schedule();
      return () => {
        digestTimerDisposer?.();
        digestTimerDisposer = undefined;
      };
    }, 'qq-bridge:memory-digest');
  }

  // 记忆停用时整块不给：`registerQqTools` 会连那两个工具一起跳过，不留「一调就报错」的壳。
  const tools = memoryEnabled
    ? {
        describeLine: describeTranscriptLine,
        listTranscripts,
        resolveConversation: resolveMemoryConversation,
        searchTranscript,
        readTranscript,
        listFiles: listMemoryFiles,
        resolvePath: resolveMemoryPath,
        readFile: readMemoryFile,
        searchFile: searchMemoryFile,
        writeFile: writeMemoryFile,
        upsertEntry: upsertMemoryEntry,
        removeEntry: removeMemoryEntry,
      }
    : undefined;

  return {
    /** 记忆到底有没有生效（`memory: false` 或 `memoryDir` 越界时是 false）。 */
    enabled: memoryEnabled,
    /** 记忆目录的展示路径（相对 cwd、正斜杠）；停用时是空串。 */
    label: memoryLabel,
    /** handleEvent 每收到一条别人的消息调一次（后台追加，不等落盘）。 */
    rememberTranscript,
    /** 收到撤回通知时调一次：在转录里追加一行「已撤回」标记（见 `noteRecall`）。 */
    noteRecall,
    /**
     * 渠道提示里的记忆段落（检索式注入，见 `recallText`）。
     *
     * 旧名字 `indexText` 保留成同一个函数：它的语义已经从「读索引」变成「按当前消息
     * 检索」，但调用点只有 index.js 一处，不值得为改名再造一次破坏。
     */
    recallText,
    indexText: recallText,
    /** 手动跑一次滚档（测试与 ops 排查用；正常路径由摘要 / 写入自己触发）。 */
    rollover: rolloverMemory,
    /** 重新从磁盘读一次统计（摘要写完 / 人工改了 index json 之后用）。 */
    reloadStats: loadStats,
    /** 渠道提示里的表情包目录与热梗段（同步读数，见 `catalogState`）。 */
    catalog: catalogState,
    /** `qq_save_sticker` 存完图之后调：把这一行追加进 STICKERS.md（失败只返回原因）。 */
    appendSticker: appendStickerCatalog,
    /** `qq_rename_sticker` 改名之后调：把目录里那一条搬到新名字下（返回 ok / reason）。 */
    renameSticker: renameStickerEntry,
    /** 两个记忆工具是否可见（开关 + allowTools 白名单）。 */
    toolsAllowed: memoryToolsAllowed,
    /** 摘要定时器的装配（见上面的生命周期注释；index.js 在生命周期那一节调）。 */
    startDigestTimer,
    /** 交给 `registerQqTools` 的依赖表；停用时是 undefined（那两个工具不注册）。 */
    tools,
  };
}
