/**
 * 合并转发（OneBot 的 `forward` / `node` 段）的展开。
 *
 * 为什么这件事值得单独一个模块：
 *   - NapCat 默认 `parseMultMsg: true`，转发段的 `data.content` 里**已经带着**每条子消
 *     息的完整结构（`sender` + `message` 段），绝大多数情况根本不用调 API；只有
 *     `parseMultMsg: false` 或别的实现（go-cqhttp / Lagrange）才只给一个 `data.id`，
 *     需要补一次 `get_forward_msg`。两条来源要归一成同一种「节点」。
 *   - 子消息同样是**别人写的内容**，展开等于把一整段聊天记录喂进上下文。所以这里只做
 *     有界展开：条数、字数、嵌套深度都有上限，超出的部分明确写成「还有 N 条没展开」，
 *     而不是让一条转发把整轮上下文撑爆。
 *
 * 本模块**不碰媒体、不碰会话**：每条子消息里的图要不要落盘、怎么渲染，由调用方传进来的
 * `renderNode` 决定。这样它才能被单测，也才不会为了渲染一行字顺手发一次网络请求。
 *
 * 依赖方向：叶子模块，没有 import。
 *
 * @module @qqbot/dsh-plugin-qq/forward
 */

/** 默认最多展开多少条子消息。 */
const DEFAULT_MAX_NODES = 20;

/** 默认最多展开多少字（含开头那行 `[合并转发 N 条]`）。 */
const DEFAULT_MAX_CHARS = 1200;

/**
 * 转发段自带的子消息：NapCat 的 `parseMultMsg` 打开时就是这个字段。
 *
 * 空数组按「没有内联内容」处理 —— 少数实现会给一个空数组占位，那种情况仍然应该去
 * 问一次 `get_forward_msg`，不能因为字段存在就当「转发里什么都没有」。
 *
 * @param segment - 一个消息段（可能为 null / 结构不对）。
 * @returns 子消息数组；没有可用内容时 undefined。
 */
export function forwardNodes(segment) {
  const content = segment?.data?.content;
  return Array.isArray(content) && content.length > 0 ? content : undefined;
}

/**
 * 转发段的 id（没有内联内容时用它去 `get_forward_msg`）。
 *
 * NapCat 给的是消息 id，go-cqhttp 给的是转发的 resId —— 两种都是「原样传回去」，
 * 这里不猜格式，只要求非空。
 *
 * @param segment - 一个消息段。
 * @returns id 字符串；没有时为空串。
 */
export function forwardId(segment) {
  const id = segment?.data?.id;
  if (typeof id === 'string') return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return '';
}

/**
 * 把一个「节点」归一成 `{ name, message }`。
 *
 * 真实实现给了三种形状，都要认：
 *   - NapCat 内联内容：一条完整消息对象 `{ sender: { card, nickname }, message: [...] }`；
 *   - `get_forward_msg` 的返回：同样是消息对象（`messages: [...]`）；
 *   - 嵌套转发：`{ type: 'node', data: { nickname, user_id, message: [...] } }`。
 *
 * @param raw - 原始节点。
 * @returns `{ name, message }`；认不出来时 undefined。
 */
export function forwardNode(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  // `node` 段把内容包在 `data` 里；消息对象则直接摊在根上。
  const data = raw.type === 'node' && isPlainObject(raw.data) ? raw.data : raw;
  const message = Array.isArray(data.message)
    ? data.message
    : Array.isArray(data.content)
      ? data.content
      : typeof data.message === 'string'
        ? data.message
        : typeof data.content === 'string'
          ? data.content
          : undefined;
  if (message === undefined) return undefined;
  const sender = isPlainObject(data.sender) ? data.sender : {};
  // 群里大家认的是群名片；没有才退昵称、QQ 号。与 `userDisplayName` 的口径一致，
  // 别在这里另立一套（否则同一个人的名字在正文与转发里会不一样）。
  const name = shortName(sender.card)
    || shortName(sender.nickname)
    || shortName(data.nickname)
    || shortName(data.user_id)
    || shortName(sender.user_id)
    || '某人';
  return { name, message };
}

/**
 * 从 `get_forward_msg` 的返回里取节点数组。
 *
 * NapCat / go-cqhttp 都返回 `{ messages: [...] }`；个别实现直接给数组或 `{ message }`。
 * 认不出来就 undefined（调用方保留 `[合并转发]` 占位符）。
 *
 * @param data - API 的 `data` 负载。
 * @returns 节点数组；没有时 undefined。
 */
function responseNodes(data) {
  if (Array.isArray(data)) return data;
  if (!isPlainObject(data)) return undefined;
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.message)) return data.message;
  return undefined;
}

/**
 * 调 `get_forward_msg` 取没有内联内容的转发。
 *
 * 参数名两种写法都试：`{ id }` 是 go-cqhttp / NapCat 的主参数，个别实现对内层消息只
 * 认 `{ message_id }`。**任何失败都只返回 undefined**：转发取不到不该打断消息投递，
 * 调用方保留占位符即可。
 *
 * @param call - OneBot 调用函数 `(action, params) => Promise<data>`。
 * @param id - {@link forwardId} 给出的 id。
 * @returns 节点数组；取不到时 undefined。
 */
export async function fetchForwardNodes(call, id) {
  if (typeof call !== 'function' || typeof id !== 'string' || id === '') return undefined;
  for (const params of [{ id }, { message_id: id }]) {
    try {
      const data = await call('get_forward_msg', params);
      const nodes = responseNodes(data);
      if (nodes !== undefined) return nodes;
    } catch {
      // 参数名不对 / 消息已过期 / 实现不支持：换下一种写法；都不行就交给调用方降级。
    }
  }
  return undefined;
}

/**
 * 把节点数组渲染成一段有界的「谁: 什么」。
 *
 * 三条边界都在这里，而不是散在调用方：
 *   - `maxNodes`：最多展开多少条，剩下的写成「还有 N 条没展开」；
 *   - `maxChars`：到顶就停（**也计入开头那行**），避免一条长转发占掉整轮上下文；
 *   - 默认把单条子消息的换行折成空格：一行一条才看得出「这是谁说的另一句」。
 *
 * `multiline` 是给嵌套转发用的：父行的正文里要能出现「另起一行、缩进两格」的块，
 * 所以这时**保留换行与行首缩进**，只清行尾空白与首尾空行；普通正文由调用方先折成一行。
 * `closing` 会在块尾追加 `[/合并转发]`：嵌套块需要一个明确的结束边界，否则模型只能
 * 靠缩进猜「这一层到哪儿为止」。最外层不加（消息本身就到头了，省一行）。
 *
 * @param nodes - {@link forwardNode} 能认的节点数组。
 * @param options - `renderNode`（异步，把 `{ name, message }` 渲染成一段正文）、
 *   `maxNodes`、`maxChars`、`multiline`、`closing`。
 * @returns 渲染结果；没有可认的节点 / 没有 renderNode 时 undefined。
 */
export async function renderForwardNodes(nodes, {
  renderNode,
  maxNodes = DEFAULT_MAX_NODES,
  maxChars = DEFAULT_MAX_CHARS,
  multiline = false,
  closing = false,
} = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (list.length === 0 || typeof renderNode !== 'function') return undefined;
  const nodeLimit = positiveInt(maxNodes, DEFAULT_MAX_NODES);
  const charLimit = positiveInt(maxChars, DEFAULT_MAX_CHARS);
  // 嵌套块的结束标记先占住预算：正文把字数吃光之后，不能把边界也吃掉。
  const closingLine = '[/合并转发]';
  const budget = closing ? Math.max(1, charLimit - closingLine.length - 1) : charLimit;
  const lines = [`[合并转发 ${list.length} 条]`];
  let used = lines[0].length;
  // `consumed` 管条数上限（认不出的节点也占一个名额），`shown` 管真正写出去的行。
  // 两者分开，「还有 N 条没展开」才能把认不出的那几条也算进去。
  let consumed = 0;
  let shown = 0;
  for (const raw of list) {
    if (consumed >= nodeLimit) break;
    consumed += 1;
    const node = forwardNode(raw);
    if (node === undefined) continue;
    // 名字与换行先扣掉，剩下的才是这条正文能用的字数。先算再 `renderNode`：
    // 一点预算都没有时不该为了马上被丢掉的一行去展开嵌套转发、下载图。
    const prefix = `${node.name}: `;
    const remaining = budget - used - prefix.length - 1;
    if (remaining <= 0) break;
    let body = '';
    try {
      body = String((await renderNode(node)) ?? '');
      if (multiline) {
        // 多行模式只清行尾空白与首尾空行；换行与行首缩进是调用方有意排的。
        body = body.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '').trimEnd();
      } else {
        body = body.replace(/\s+/g, ' ').trim();
      }
    } catch {
      // 单条渲染失败只影响这一条：转发本身还是要让模型看见。
      body = '';
    }
    let truncated = false;
    // 按码点切，别把 emoji 的代理对切成半个。最后留一个 `…` 说明「这条还有后半段」——
    // 一条五千字的转发如果整条丢掉，模型会以为里面什么都没说。
    const chars = Array.from(body);
    if (chars.length > remaining) {
      body = `${chars.slice(0, Math.max(0, remaining - 1)).join('')}…`;
      truncated = true;
    }
    const line = `${prefix}${body.length > 0 ? body : '（空消息）'}`;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
    // 一条被截断的正文已经把剩余预算吃完了，后面的不必再看。
    if (truncated) break;
  }
  const hidden = list.length - shown;
  if (hidden > 0) lines.push(`…（还有 ${hidden} 条没展开）`);
  if (closing) lines.push(closingLine);
  return lines.join('\n');
}

/**
 * 展开一个转发 / 嵌套 node 段。
 *
 * 有内联 `data.content` 就直接用（NapCat 默认路径，零 API 调用）；没有才按 `data.id`
 * 去取一次。取不到时返回 undefined，调用方保留 `[合并转发 N 条]` 占位符。
 *
 * @param segment - `forward` 或 `node` 段。
 * @param options - `call`、`renderNode`、`maxNodes`、`maxChars`、`multiline`、`closing`
 *   （见 {@link renderForwardNodes}）。
 * @returns 展开后的正文；无法展开时 undefined。
 */
export async function expandForward(segment, { call, renderNode, maxNodes, maxChars, multiline = false, closing = false } = {}) {
  if (segment === null || typeof segment !== 'object') return undefined;
  // 嵌套转发在 NapCat 里是 `node` 段，它本身就是一条子消息，不需要再取。
  let nodes;
  if (segment.type === 'node') {
    nodes = [segment];
  } else {
    nodes = forwardNodes(segment);
    if (nodes === undefined) {
      const id = forwardId(segment);
      if (id === '') return undefined;
      nodes = await fetchForwardNodes(call, id);
    }
  }
  if (nodes === undefined || nodes.length === 0) return undefined;
  return renderForwardNodes(nodes, { renderNode, maxNodes, maxChars, multiline, closing });
}

/**
 * 正数兜底：非数 / 0 / 负数都退回默认值（上限参数写错时宁可保守，不要变成「不限」）。
 * @param value - 待转换的值。
 * @param fallback - 默认值。
 * @returns 正整数。
 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/**
 * 名字的显示上限：一行「谁: 什么」里名字不该占掉半屏。
 * @param value - 群名片 / 昵称 / QQ 号。
 * @returns 折叠空白、截断后的名字；没有可用内容时为空串。
 */
function shortName(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 40).join('');
}

/**
 * 非数组的普通对象。
 * @param value - 待判定值。
 * @returns 是普通对象时为 true。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
