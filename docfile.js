/**
 * 「cwd 里的热读文档」：人设 / 表达 / 认知之外的这类**部署者手写**的文本文件。
 *
 * 三个约束决定了这个模块的写法，缺一个都会出错：
 *
 *   1. **提示词 provider 是同步求值的**（`SystemPrompt.section()` 每次装配都要重算），
 *      所以只能同步读，不能 await；
 *   2. **热改**：部署者改完文件不该重启进程才生效，所以用 `size:mtime` 做缓存键 ——
 *      文件没变就零读取，变了下一次装配立刻是新内容；
 *   3. **必须在 cwd 内**：这些文件会被拼进提示词，而 cwd 是沙箱根。配到外面只记一条
 *      warn 并停用（与 `mediaDir` / `memoryDir` 同一套路，不抛错）。
 *
 * 读不到/权限错/是目录：一律当作「没有这个文件」，由调用方决定回退到哪一版默认值。
 * 文档写坏不能让机器人不说话 —— 这一条贯穿整个人格层。
 *
 * @module @qqbot/dsh-plugin-qq/docfile
 */
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathInside } from './util.js';

/**
 * 造一个「读某个人格/风格文档」的读取器。
 *
 * @param {object} options
 * @param {string} options.cwd - 工作目录（沙箱根，也是越界校验的基准）。
 * @param {string} options.file - 配置里的文件路径（相对 cwd，或 cwd 内的绝对路径）。
 * @param {number} options.maxChars - 超过就截断（提示词预算）。
 * @param {(level: string, message: string) => void} options.report - 日志（越界/截断各记一次）。
 * @param {string} options.label - 日志里怎么称呼这份文档（`人设` / `表达规则`）。
 * @returns `{ path, label, read }`：`read()` 返回 `{ text, truncated }`，文件不存在时
 *   `text` 为 undefined；`path` 是解析后的绝对路径（用于日志与提示）。
 */
export function createDocReader({ cwd, file, maxChars = 4000, report, label = '文档' }) {
  const root = resolve(cwd ?? process.cwd());
  const raw = String(file ?? '').trim();
  const absolute = raw.length > 0 ? resolve(root, raw) : '';
  const inside = absolute.length > 0 && pathInside(root, absolute);
  const relativeLabel = inside ? relative(root, absolute).split(sep).join('/') : raw;
  if (raw.length > 0 && !inside) {
    report('warn', `${label}文件 "${raw}" resolves outside cwd (${root}); it will be ignored`);
  }
  /** 缓存键：`size:mtime`；文件没变就不重读。 */
  let cached = { key: '', text: undefined, truncated: false };

  return {
    path: inside ? relativeLabel : '',
    label,
    /**
     * 读一次（有缓存）。同步 —— 调用方是提示词 provider。
     * @returns `{ text: string|undefined, truncated: boolean }`。
     */
    read() {
      if (!inside) return { text: undefined, truncated: false };
      let info;
      try {
        info = statSync(absolute);
        if (!info.isFile()) return { text: undefined, truncated: false };
      } catch {
        // 文件不存在（或者刚被删掉）：这是**没配置**，不是错误，不记日志。
        return { text: undefined, truncated: false };
      }
      const key = `${info.size}:${info.mtimeMs}`;
      if (key === cached.key) return { text: cached.text, truncated: cached.truncated };
      let text;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch (error) {
        report('warn', `${label}文件 ${relativeLabel} 读不出来：${error?.message ?? error}`);
        cached = { key, text: undefined, truncated: false };
        return { text: undefined, truncated: false };
      }
      const limit = Math.max(200, Math.floor(Number(maxChars) || 0) || 4000);
      const truncated = text.length > limit;
      if (truncated) {
        report('warn', `${label}文件 ${relativeLabel} 超过 ${limit} 字，已截断（改小一点，别把提示词预算撑爆）`);
        text = text.slice(0, limit);
      }
      cached = { key, text, truncated };
      return { text, truncated };
    },
  };
}
