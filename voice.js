/**
 * 语音转文字：把 QQ 的语音消息（OneBot 的 `record` 段）变成模型能读的一句话。
 *
 * 为什么是「调接口」而不是「自己转写」：
 *   - QQ 客户端本身就带语音转文字（服务端识别），NapCat 把它暴露成 OneBot action
 *     `fetch_ptt_text`（入参 `{ message_id }`，出参 `{ text }`）。仓库不需要引入任何
 *     第三方识别服务，也不下载/解码 SILK。
 *   - NapCat 上报的 `record` 段里**没有**转写文字（`pttElement` 的 `text` 只在
 *     `translatePtt2Text` 之后才由 `fetch_ptt_text` 读出来），所以入站时必须补一次。
 *
 * 链路：QQ 语音 → `record` 段 → `resolveVoiceTranscripts()` → 段下标 → 正文文本
 *      → `messageToText()` → Agent。失败时**原样保留** `[语音 N 秒]` 占位符，消息照常投递。
 *
 * 设计边界：
 *   - 本模块只做「一条消息 → 一段文字」，不碰磁盘、不发消息、不认识 settings；
 *     `call` / `maxChars` / `report` 全部由调用方注入，方便单测。
 *   - 一条消息里有多段语音时只转写**第一段**：`fetch_ptt_text` 是按 message_id 找
 *     PTT 元素，一条消息里多段语音是极少数情况，多调几次只会互相覆盖。
 *   - 转写文字来自 QQ（不可信输入），这里只折成一行、截断，不解释、不执行。
 *
 * @module @qqbot/dsh-plugin-qq/voice
 */

import { inlineVoiceTranscript, observationOf, renderObservation } from './modalities.js';

/** NapCat（以及对齐它的实现）取语音转写文字的 action 名。 */
export const VOICE_TRANSCRIPT_ACTION = 'fetch_ptt_text';

/** 没有配置时最多保留多少字的转写。 */
const DEFAULT_TRANSCRIPT_MAX_CHARS = 500;

/**
 * 这个段是不是语音。
 *
 * @param segment - 一个 `{ type, data }` 消息段（可能是 null / 结构不对）。
 * @returns `record`（OneBot v11）或 `voice`（部分实现的别名）时为 true。
 */
export function isVoiceSegment(segment) {
  return segment?.type === 'record' || segment?.type === 'voice';
}

/**
 * 把一段转写规整成「一行、无首尾空白、不超长」。
 *
 * 为什么要折成一行：正文最终会被 `batch.js` 的一条消息一行渲染；转写里若有换行，
 * 会把 `名字: 正文` 的归属切断。超长则截断并补 `…`，避免一段语音把整轮上下文撑爆。
 *
 * @param value - 协议端 / `fetch_ptt_text` 给的文字（可能不是字符串）。
 * @param maxChars - 最多保留多少字；非法值退回 500。
 * @returns 规整后的文字；没有可用内容时为空串。
 */
export function normalizeVoiceTranscript(value, maxChars = DEFAULT_TRANSCRIPT_MAX_CHARS) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_TRANSCRIPT_MAX_CHARS;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * 把「语音段 + 转写文字」渲染成正文里的那一句。
 *
 * 格式由 `modalities.js` 统一负责（时长单位、方括号、换行都在那里），这里只是把
 * `meta.transcript` 补进去再交给它渲染，保证与既有占位符是同一个出口。
 *
 * @param segment - `record` / `voice` 消息段。
 * @param transcript - 已规整的转写文字。
 * @returns 例如 `[语音 3 秒｜这是一条语音消息，语音转文字内容如下：今天天气不错]`。
 */
export function voiceTranscriptPlaceholder(segment, transcript) {
  const observation = observationOf(segment);
  observation.meta = { ...observation.meta, transcript };
  observation.status = 'ok';
  return renderObservation(observation);
}

/**
 * 一条消息里的语音 → `段下标 → 渲染文本`。
 *
 * 两路来源：
 *   1. 协议端直接把转写放在段里（`data.text` / `data.transcript`）—— 有就用，不发请求；
 *   2. 否则调 `fetch_ptt_text`（QQ 官方转写），只取第一条语音的结果。
 *
 * 任何失败（实现不支持、消息已撤回、QQ 那边没给文字、超时）都只返回 `undefined`，
 * 由调用方保留原来的 `[语音 N 秒]` 占位符 —— 一条语音转不出来不该拖垮整条消息。
 *
 * @param message - OneBot 的 `message` 字段（消息段数组；字符串 / 畸形输入直接放弃）。
 * @param options.messageId - 这条消息的 `message_id`（`fetch_ptt_text` 要用）。
 * @param options.call - `(action, params) => Promise<data>`，生产上是 OneBot 客户端。
 * @param options.maxChars - 最多保留多少字。
 * @param options.report - `(level, text) => void` 日志回调。
 * @returns `Map<number, string>`；没有语音或没取到任何文字时 undefined。
 */
export async function resolveVoiceTranscripts(message, { messageId = '', call, maxChars = DEFAULT_TRANSCRIPT_MAX_CHARS, report } = {}) {
  if (!Array.isArray(message)) return undefined;
  /** @type {{ index: number, segment: object }[]} */
  const targets = [];
  message.forEach((segment, index) => {
    if (isVoiceSegment(segment)) targets.push({ index, segment });
  });
  if (targets.length === 0) return undefined;

  const rendered = new Map();
  /** 需要调接口的那些（段里没自带转写）。 */
  const pending = [];
  for (const target of targets) {
    const inline = normalizeVoiceTranscript(inlineVoiceTranscript(target.segment?.data), maxChars);
    if (inline.length > 0) rendered.set(target.index, voiceTranscriptPlaceholder(target.segment, inline));
    else pending.push(target);
  }
  if (pending.length === 0) return rendered;

  const id = String(messageId ?? '');
  if (typeof call !== 'function' || id.length === 0) {
    report?.('info', 'voice: no message id / OneBot client, keeping the placeholder');
    return rendered.size > 0 ? rendered : undefined;
  }

  try {
    // NapCat 的 schema 同时接受数字与字符串；优先数字，兼容只认整数的实现。
    // QQ 转写偶尔要等服务端算完（第一次 retcode 1200「获取结果失败」），
    // 失败/空结果重试一次；仍失败才降级成占位符。
    let data;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        data = await call(VOICE_TRANSCRIPT_ACTION, { message_id: /^\d+$/.test(id) ? Number(id) : id });
        if (normalizeVoiceTranscript(data?.text, maxChars).length > 0) break;
      } catch (error) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          continue;
        }
        throw error;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const text = normalizeVoiceTranscript(data?.text, maxChars);
    if (text.length === 0) {
      report?.('info', `voice: message ${id} has no transcript`);
      return rendered.size > 0 ? rendered : undefined;
    }
    const first = pending[0];
    rendered.set(first.index, voiceTranscriptPlaceholder(first.segment, text));
    report?.('info', `voice: transcript ${text.length} chars for message ${id}`);
  } catch (error) {
    // 常见：NapCat 版本没有这个 action、消息已过期、QQ 服务端没返回文字。
    // 只记 info（不是 warn）：这是「降级成占位符」，不是链路故障。
    report?.('info', `voice: no transcript for message ${id} (${error?.message ?? error})`);
  }
  return rendered.size > 0 ? rendered : undefined;
}
