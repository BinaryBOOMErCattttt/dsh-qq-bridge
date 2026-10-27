/**
 * 不碰任何运行时状态的纯函数：会话 id 的派生、文本压缩、本地时间、记忆路径边界、
 * API key 池的解析与打码、主动说话的时段判定。
 *
 * 从 `index.js` 搬出来，是因为它们本来就与闭包无关（不认 `cwd`、不认配置、不读写磁盘），
 * 混在那 4600 行里只会让人以为改它们要顾虑哪张 Map。搬出来之后**不要**再把闭包状态
 * 塞进来 —— 需要状态的逻辑留在 `index.js`，这里只留「给同样的输入永远同样的输出」。
 *
 * `sessionIdFor` / `parseApiKeyPool` / `withinActiveHours` 导出的目的是让测试直接验契约
 * （第 0 轮的 id 逐位不变 / 池子的三条解析规则 / 时段的四种边界），`index.js` 会再把它们
 * 导出一次给 `test/bridge.test.mjs`。
 *
 * @module @qqbot/dsh-plugin-qq/util
 */
import crypto from 'node:crypto';
import { resolve } from 'node:path';

/**
 * 设置页「重置对话」那一块用的 Host 路由。
 *
 * 它是一份**跨半侧的协议**：Host（`index.js`）在 Connection 的认证栅栏内注册它，
 * 浏览器半侧（`client.js`，手写 bundle、不能 import 主机模块）照着字符串再写一份。
 * 两份必须逐字相同 —— `test/client.test.mjs` 拿这个常量钉住那一份拷贝，漏改一边会红。
 * 与 `REMINDER_ROUTE_PATH`（住在 `reminders.js`）同理。
 */
export const SESSION_ROUTE_PATH = '/api/qq-bridge/sessions';

/**
 * 由会话 key 派生出稳定的、UUID 形状的 Session id。
 *
 * 确定性正是关键：同一个 QQ 会话在 Harness 反复重启后仍然得到同一个
 * Session id，因此可以 resume 历史会话，聊天记忆不会丢。
 * 做法是把 SHA-256 摘要裁剪成 UUID 形状，并把版本位/变体位写成固定值，
 * 以便通过 Harness 对 session id 的格式校验。
 *
 * `generation` 是「这是这个会话的第几轮」：0 是第一轮，`/reset` 每按一次 +1。
 * 它只参与摘要，不改变派生算法本身 —— 于是**第 0 轮永远是过去那个 id**
 * （已有会话的记忆不会因为这次改动被隔断），而第 1 轮起又是确定性的：
 * 重启、换进程、重新算，都还是同一个 id，该 resume 的就 resume。
 *
 * 为什么不是「删掉旧会话、原地重建」：`/reset` 的语义已经改成
 * **新开一轮会话**（见 `resetConversation`）。旧会话的记录留在磁盘上
 * 当作这段聊天的存档，不再被带进新一轮的上下文，也不再被删掉。
 *
 * 导出只为让测试能直接验「第 0 轮的 id 与改动前一致、第 1 轮换新且跨进程稳定」
 * 这条契约：它不碰任何闭包状态。
 *
 * @param key - 会话 key，例如 `group:100000001`。
 * @param generation - 第几轮会话（非负整数，0 = 第一轮）；非法值按 0 处理。
 * @returns 版本 5 形状的 UUID 字符串。
 */
export function sessionIdFor(key, generation = 0) {
  const round = Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  // 第 0 轮刻意用**和改动前一模一样**的输入串：历史会话的 id 不能变。
  const seed = round === 0 ? `dsh-qq-bridge:${key}` : `dsh-qq-bridge:${key}:reset:${round}`;
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 把一条 assistant 消息里可见的文本块拼起来。
 * 工具调用、思考等非 text 块都会被忽略。
 * @param content - 持久化消息的 content 块数组。
 * @returns 拼接后的可见文本（已 trim）。
 */
export function visibleText(content) {
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
export function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/**
 * 会话 key 里所有会被当成路径分隔符或非法文件名的字符。
 *
 * 冒号在 `group:123` 里是分隔符，但在 Windows 上不能出现在文件名里，也会让
 * `.qq-memory/conversations/group:123/` 这种路径在所有平台上都难读 —— 所以它
 * 和空格、斜杠一样折成 `-`（`MEMORY_SLUG_UNSAFE` 之外的字符才原样保留）。
 */
const MEMORY_SLUG_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * 把会话 key（`group:100000001` / `private:100000002`）变成安全的目录名。
 *
 * 只做「可逆地可读」：`group:` 换成 `group-`（冒号在部分文件系统上不合法），
 * 其余非法字符一律折成 `-`。真正的稳定性靠 key 本身而不是这个变换 —— 调用方
 * 每个进程只算一次并存进 `memorySlugs`，同一个会话永远只有一个目录。
 * @param key - 会话 key。
 * @returns 目录名，例如 `group-100000001`。
 */
export function memorySlug(key) {
  const slug = String(key ?? '').replace(MEMORY_SLUG_UNSAFE, '-').replace(/^[.-]+/, '');
  return slug.length > 0 ? slug.slice(0, 120) : 'unknown';
}

/** 本地日期（`YYYY-MM-DD`）：聊天记录按人所在地的日期切分，不用 UTC。 */
export function localDate(at = Date.now()) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 本地日期时间（`YYYY-MM-DD HH:MM:SS`）：转录输出与日志里统一用它。
 *
 * 与 {@link localDate} 一样刻意用**本地时间** —— 「上一次摘要是昨天还是今天」这件事
 * 必须按人所在地的日界线算，否则东八区的凌晨 4 点会被算成前一天的 UTC。
 * @param at - 毫秒时间戳。
 * @returns 本地时间戳字符串。
 */
export function localStamp(at) {
  const date = new Date(Number(at) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 本地日期时间（`YYYY-MM-DD HH:MM`，到分钟）：定时提醒的展示与解析都用它。
 *
 * 刻意只到分钟：提醒的精度就是分钟级，秒既没有意义，也会让「输入 09:00、回显 09:00:00」
 * 这种对照多一处不一致。与 {@link localStamp} 一样用**本地时间**。
 * @param at - 毫秒时间戳。
 * @returns 本地 `YYYY-MM-DD HH:MM`。
 */
export function localMinute(at = Date.now()) {
  const date = new Date(Number(at) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 本地星期（`周一` … `周日`）：提示词里要告诉模型「今天是周几」，
 * 否则「下周一」这种说法它只能靠猜。
 * @param at - 毫秒时间戳。
 * @returns 中文星期。
 */
export function weekdayLabel(at = Date.now()) {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return labels[new Date(Number(at) || Date.now()).getDay()];
}

/**
 * 粗粒度时段（`YYYY-MM-DD 凌晨|早上|中午|晚上`）：提示词里只给这一档。
 *
 * 为什么故意这么粗：提示词每变一个字，DSH 都会把变化后的整段系统提示（含人设 +
 * 表达契约 + 硬性规则）当成新的 system 消息追加进历史（`systemPromptUpdate: 'in-history'`）。
 * 「现在是 14:37」这种每分钟都变的写法会把它变成每轮追加一份；按 00 / 06 / 12 / 18
 * 切成四段之后，一天最多变四次。要精确时刻让模型调 `qq_time`。
 * @param at - 毫秒时间戳。
 * @returns 本地日期 + 时段，例如 `2026-10-26 早上`。
 */
export function timeBucketLabel(at = Date.now()) {
  const stamp = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const hour = new Date(stamp).getHours();
  const bucket = hour < 6 ? '凌晨' : hour < 12 ? '早上' : hour < 18 ? '中午' : '晚上';
  return `${localDate(stamp)} ${bucket}`;
}

/**
 * 解析模型给的本地时间（`YYYY-MM-DDTHH:MM` 或空格分隔），返回毫秒时间戳。
 *
 * **不用 `Date.parse`**：它对「带不带时区、空格还是 T」的解释在不同实现/不同时区下
 * 并不一致，而提醒最不能出的错就是「静默差一小时」。这里逐段解析、用本地 `Date`
 * 构造，再回读年月日校验 —— `2026-02-30` 会被 `Date` 滚成 3 月 2 日，回读就能拦住。
 *
 * @param text - 时间字符串。
 * @returns `{ at, text }`（`text` 是归一化后的 `YYYY-MM-DD HH:MM`）；非法时 undefined。
 */
export function parseLocalMinute(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map((part) => Number(part));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return undefined;
  }
  return { at: date.getTime(), text: localMinute(date.getTime()) };
}

/**
 * 计算「下一个每天 `hour` 点」距今多少毫秒。
 *
 * 定时摘要只在每天固定的一个时刻醒来，所以间隔不是常数：醒来一次之后必须重新算到
 * 明天的那个点。跨过夏令时/时区变更时以本地时间为准（差一小时无所谓，摘要不是列车
 * 时刻表），但**刚过点时必须排到明天**，否则会在同一个点上反复醒来。
 * @param hour - 本地小时（0~23）。
 * @param now - 当前时刻（毫秒），测试里可注入。
 * @returns 距下一次触发点的毫秒数，至少 1 秒。
 */
export function msUntilDailyHour(hour, now = Date.now()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - now);
}

/** 本地 `HH:00`：日志与报错里描述触发点的写法。 */
export function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * 解析 API key 池文件（一行一个 key）。
 *
 * 规则刻意只有三条：空行跳过、`#` 开头的整行是注释、重复的 key 只留第一条。
 * 不做「行内注释」也不做 `KEY=value` —— key 自身可能含 `=` 之外的符号，多一种语法就多
 * 一种「为什么我的 key 没被认出来」；想给某个 key 写备注就单独一行 `#`。
 *
 * 导出只为让测试直接验这几条边界（注释 / 空行 / CRLF / 重复）：它不碰任何闭包状态。
 * @param text - 池子文件的正文。
 * @returns 按出现顺序去重后的 key 数组。
 */
export function parseApiKeyPool(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * 日志里给一个 key 打码：露前 6 个字符 + 内容摘要的前 8 位十六进制。
 *
 * 日志会进 journal、也可能被贴到别处，所以**绝不能**整条打出来。留前 6 位是为了让
 * 「换成了哪个」在池子里一眼可辨（`sk-` 之后还有三个随机字符），摘要则用来确认
 * 「池子里两行是不是同一个 key」—— 两者都不足以还原出一个可用的 key。
 * @param key - 原始 key。
 * @returns 形如 `sk-ab1…#1a2b3c4d` 的短标识。
 */
export function apiKeyFingerprint(key) {
  const text = String(key ?? '');
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  const head = text.length > 8 ? `${text.slice(0, 6)}…` : '';
  return `${head}#${digest}`;
}

/**
 * 某个本地小时在不在「可以主动说话」的时段里。
 *
 * 真人半夜不会突然在群里冒泡，所以主动说话只发生在配置的时段内。取值一律按本地小时
 * （与摘要的 `digestAtHour` 同一个口径：东八区的晚上十点就是 22，不是 UTC 的 14）。
 * 三条规则：
 *   - `from` 到 `to` **左闭右开**：9 → 23 是 09:00~22:59；
 *   - 两边相等表示「全天」（`from = to = 0` 时不必写成 0 → 24）；
 *   - `from > to` 表示跨零点，例如 22 → 3 = 22:00 到次日 02:59。
 * 非法值按「不设限」处理（from 兜底 0、to 兜底 23），因为这里的目标是别让一个配错的
 * 小时数把功能整体打死 —— 真要收紧该由 `proactive` 开关负责。
 *
 * 导出只为让测试能直接验边界（跨零点、左闭右开、全天）：它不碰任何闭包状态。
 *
 * @param from - 起始本地小时（0~23）。
 * @param to - 结束本地小时（0~23，不含）。
 * @param hour - 要判断的本地小时（0~23）。
 * @returns 可以说话时为 true。
 */
export function withinActiveHours(from, to, hour) {
  const start = Number.isFinite(Number(from)) ? Math.min(23, Math.max(0, Math.floor(Number(from)))) : 0;
  const end = Number.isFinite(Number(to)) ? Math.min(23, Math.max(0, Math.floor(Number(to)))) : 23;
  const at = Number.isFinite(Number(hour)) ? Math.min(23, Math.max(0, Math.floor(Number(hour)))) : 0;
  if (start === end) return true;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** 把一行记忆里的换行折掉：记忆是「一行一条事实」，格式被换行破坏就没法读了。 */
export function memoryOneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把模型给的表情包名字清洗成一个**单层文件名**，扩展名一律以真实图片格式为准。
 *
 * 这是 `qq_save_sticker` 的写边界，所以按「QQ 消息是不可信输入」来写：
 *   - 目录部分直接丢掉（`../../etc/passwd` → `passwd`），只保留最后一段 —— 比「遇到
 *     分隔符就拒绝」友好：模型经常把 `.qq-stickers/委屈` 整串当名字传进来；
 *   - 去掉控制字符与 Windows 非法字符（`:*?"<>|`），结尾的点/空格也去掉（那边不允许）；
 *   - 开头的点去掉：`.` 开头是隐藏文件，而列表情包目录时隐藏文件是被跳过的，
 *     存下来却看不见等于没存；
 *   - 扩展名不看模型写的那个，用 `sniffImageExtension` 嗅出来的真格式 —— 否则会出现
 *     `笑死.png` 里装着 GIF 字节这种「发得出去、但目录看名字以为是别的格式」的坑；
 *   - 长度封顶 60：名字要进每轮提示词，太长的名字是纯 token 开销。
 *
 * 导出是为了能被单测直接钉住边界（它不碰任何状态，也不碰磁盘）。
 *
 * @param raw - 模型给的名字（可以带目录、带扩展名、带非法字符）。
 * @param extension - 图片的真实扩展名（`png` / `jpg` / `gif` / `webp`）。
 * @returns 形如 `委屈.gif` 的文件名；清洗完什么都不剩、或格式不认识时 undefined。
 */
export function stickerFileName(raw, extension) {
  const ext = String(extension ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!['png', 'jpg', 'gif', 'webp'].includes(ext)) return undefined;
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  // 模型可能把扩展名一起写了（`委屈.gif`），也可能写了另一个格式的后缀（`委屈.png`）——
  // 两种都在这里剥掉，再按真实格式接一个，保证「一个名字对应一个文件」。
  const stem = cleaned.replace(/\.(png|jpe?g|gif|webp)$/i, '').replace(/[. ]+$/, '');
  if (stem.length === 0) return undefined;
  return `${stem.slice(0, 60)}.${ext}`;
}

/**
 * 把路径压成「比较用」的形状：Windows 上折成小写，其余平台原样。
 *
 * 为什么非要有这一步：NTFS **不区分大小写**，而同一个目录在这台机器上真会以不同写法
 * 出现 —— `process.cwd()` 给 `D:\…`、配置里手写 `d:\…`、`resolve()` 又可能把盘符
 * 归一成另一种大小写。按字节前缀比较的话，「明明在沙箱里」的路径会被判成越界，
 * 表现是记忆 / 表情包目录被**静默停用**（那几处越界判定失败只记一条 warn）。
 *
 * @param value - 任意路径。
 * @param platform - `process.platform` 的值（测试可注入，用来在任一平台上验 Windows 语义）。
 * @returns 可比较的键。
 */
function pathKey(value, platform) {
  const text = String(value ?? '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * 目标路径是否在 `root` 里（`root` 自身也算）—— 全项目**唯一**的路径包含判定。
 *
 * 三件事必须同时做对，否则它就是一条能被绕过的写边界或一条会误伤的沙箱边界：
 *   - **补分隔符再比较**：`/tmp/mem` 不能把 `/tmp/memory/x` 算成「在里面」；
 *   - **Windows 忽略大小写**：见 {@link pathKey}，那边同一个目录有多种写法；
 *   - **两侧都先归一化**（调用方传进来的应当已经是 `resolve()` 过的绝对路径）。
 *
 * 从 `image.js` 搬到这里，是因为它不只服务出站图片：`memoryRelativePath`（`qq_memory`
 * 的写边界）、`mediaDir` / `stickerDir` 的沙箱校验都靠同一条规矩 —— 散成
 * 三份实现迟早有一份忘了补分隔符或者忘了大小写。
 *
 * @param root - 已解析的绝对目录。
 * @param target - 已解析的绝对路径。
 * @param platform - `process.platform` 的值（测试可注入）。
 * @returns 在范围内为 true。
 */
export function pathInside(root, target, platform = process.platform) {
  const left = pathKey(root, platform);
  const right = pathKey(target, platform);
  if (right === left) return true;
  // 分隔符也要跟着 `platform` 走，而不是用宿主机的 `sep`：这个参数存在的意义就是
  // 「在任一平台上验证另一条平台的语义」，用宿主分隔符会当场得出相反的结论。
  const slash = platform === 'win32' ? '\\' : '/';
  return right.startsWith(left.endsWith(slash) ? left : `${left}${slash}`);
}

/**
 * cosmokit 的 volatile 引用协议：`createVolatile()` 造出来的引用身上带着这个 symbol，
 * 值是「把新值写进去」的函数。`isVolatileRef` 靠它就够认出引用，不必 import cosmokit
 * —— 那个包不在 `peerDependencies` 里，裸 import 会让宿主与插件各持一个副本
 * （见 AGENTS.md §2 末尾的解析规则）。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 这个配置节点是不是 cordis 的 volatile 引用（`.volatile()` 字段解析出来的东西）。
 *
 * `config.js` 的 schema 是根 volatile（整份配置一个引用），所以 `apply()` 拿到的
 * `config` 不是普通对象：读字段要先 `.get()`。判断用的是稳定的 symbol 协议，
 * 字符串/数字/布尔这类普通值永远不是引用，混着传也不会误判。
 *
 * @param value - schema 解析后的配置节点。
 * @returns 是 volatile 引用时 true。
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/**
 * 取出 volatile 引用的当前快照；普通值原样返回。
 *
 * 为什么需要它：`settings.js` 是纯函数层，只认普通对象；`index.js` 装配时用它把
 * schema 解析出来的引用摊平成一份快照。**快照会过期** —— 配置在 Web UI 里改是
 * volatile 热更新（就地换值、不重跑 apply），所以插件靠 `loader/volatile-update`
 * 事件重启自己来重建这份快照，而不是把这个引用一直留在 hand 上。
 *
 * @param value - volatile 引用或普通值。
 * @returns 引用里的当前值，或原值。
 */
export function liveConfig(value) {
  return isVolatileRef(value) ? value.get() : value;
}

/**
 * 把模型给的路径解析成记忆目录内的相对路径；越界（`../`、绝对路径）时返回 undefined。
 *
 * 这是 qq_memory 的写边界：模型只能动 `.qq-memory/` 里的东西。故意不做 glob、
 * 不跟随符号链接 —— 这里的目标是「模型不会因为一次幻觉把仓库写坏」，不是完整的
 * 沙箱（真正的沙箱在 Harness 的 fs 工具那一侧）。
 * @param base - 记忆目录的绝对路径（以分隔符结尾）。
 * @param raw - 模型给的路径。
 * @returns 规范化后的相对路径（正斜杠）；越界或为空时 undefined。
 */
export function memoryRelativePath(base, raw) {
  const text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (text.length === 0) return undefined;
  const trimmed = text.replace(/^\.\/+/, '');
  if (trimmed.startsWith('/')) return undefined;
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  // 段里出现 Windows 非法字符（`: * ? " < > |`）一律拒绝。`:` 是其中关键的一个：
  // `C:/…` 这种段会被 `resolve()` 当盘符解释，于是「相对路径」会变成另一个盘上的绝对
  // 路径；虽然包含判定随后也会拒掉它（除非记忆目录恰好在同一个盘），但那时返回的
  // 「相对路径」已经是一串带盘符的胡说八道，不如在这里就断掉。
  if (segments.some((segment) => /[:*?"<>|]/.test(segment))) return undefined;
  const root = resolve(base);
  const absolute = resolve(root, ...segments);
  // 补分隔符 + Windows 忽略大小写都在这一个判定里（见 pathInside 的注释）。
  if (!pathInside(root, absolute)) return undefined;
  return segments.join('/');
}
