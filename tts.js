/**
 * TTS 框架（不内置任何第三方服务）。
 *
 * 这里只做两件事：
 *   1. `registerTtsProvider(name, fn)` 注册一个「文字 → 音频字节」的实现；
 *   2. `synthesize()` 按名字调用它，并校验返回的字节。
 *
 * 为什么不在仓库里直接接 Edge-TTS / Azure / 其它在线语音：这些服务的音频输出、
 * 使用条款与版权限制各不相同，插件不该替使用者做选择。想接什么，就在自己的部署里
 * 注册一个 provider：
 *
 * ```js
 * import { registerTtsProvider } from './tts.js';
 *
 * registerTtsProvider('default', async ({ text }) => {
 *   // 调本地 Kokoro / Piper / 自建服务，或你自己的授权 API
 *   return { bytes: await myTts(text), format: 'wav' };
 * });
 * ```
 *
 * 然后把配置 `tts` 打开，`语音 <文字>` 就会用这个 provider。没有注册时指令会明确
 * 回「未配置」，不会偷偷联网、也不会回退到任何在线服务。
 *
 * @module @qqbot/dsh-plugin-qq/tts
 */

/** @type {Map<string, (input: { text: string, options: object, timeoutMs: number }) => Promise<{ bytes: Uint8Array|Buffer, format?: string }>>} */
const providers = new Map();

/**
 * 注册一个 TTS 实现。
 * @param {string} name - provider 名；默认实现建议用 `default`。
 * @param {(input: { text: string, options: object, timeoutMs: number }) => Promise<{ bytes: Uint8Array|Buffer, format?: string }>} fn
 * @returns {() => void} 注销函数。
 */
export function registerTtsProvider(name, fn) {
  const key = String(name ?? '').trim();
  if (key.length === 0) throw new Error('TTS provider 名字不能为空');
  if (typeof fn !== 'function') throw new Error('TTS provider 必须是函数');
  providers.set(key, fn);
  return () => {
    if (providers.get(key) === fn) providers.delete(key);
  };
}

/** 当前注册了哪些 provider（给状态/文档用）。 */
export function listTtsProviders() {
  return [...providers.keys()];
}

/**
 * 合成一段语音。没有注册 provider 时抛错，由调用方回一句人话。
 *
 * @param {object} options
 * @param {string} options.text - 要念的文字。
 * @param {string} [options.provider] - provider 名，默认 `default`。
 * @param {object} [options.options] - 透传给 provider（音色、语速等）。
 * @param {number} [options.timeoutMs] - 超时提示；provider 可自行使用。
 * @returns {Promise<{ bytes: Buffer, format: string }>}
 */
export async function synthesize({ text, provider = 'default', options = {}, timeoutMs = 30_000 }) {
  const body = String(text ?? '').trim();
  if (body.length === 0) throw new Error('要念什么？');
  const key = String(provider ?? 'default').trim() || 'default';
  const fn = providers.get(key);
  if (fn === undefined) {
    throw new Error(
      `TTS 未配置：没有注册 provider "${key}"。在 tts.js 里用 registerTtsProvider('${key}', ...) 接一个本地/已授权的实现。`,
    );
  }
  const result = await fn({ text: body, options, timeoutMs });
  if (result === null || result === undefined || result.bytes === undefined) {
    throw new Error(`TTS provider "${key}" 没有返回音频字节`);
  }
  const bytes = Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes);
  if (bytes.length === 0) throw new Error(`TTS provider "${key}" 返回了空音频`);
  return { bytes, format: String(result.format ?? 'mp3') };
}
