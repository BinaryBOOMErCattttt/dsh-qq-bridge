/**
 * 小功能共用的一个 JSON 状态文件（`data/chat-state.json`）。
 *
 * 为什么不用一堆小文件：米饭计数、木鱼、关注词、投票、纪念日、接龙状态都是「几百字节
 * 一改」的小数据，各开一个文件只换来更多的越界校验与备份。一个文件、按 section 分，
 * 写的时候整体原子写；读不到 / 写坏了就退回空对象（宁可丢计数，不要让 bot 起不来）。
 *
 * @module @qqbot/dsh-plugin-qq/chat-state
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeJsonAtomic } from './filestore.js';

/**
 * @param {{ file: string, report?: (level: string, message: string) => void }} options
 */
export function createChatState({ file, report = () => {} }) {
  let data = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') report('warn', `could not read ${file}: ${error?.message ?? error}`);
  }
  let timer;
  let dirty = false;
  let writing = false;

  async function flush() {
    if (!dirty || writing) return;
    writing = true;
    dirty = false;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeJsonAtomic(file, data);
    } catch (error) {
      report('warn', `could not save ${file}: ${error?.message ?? error}`);
    } finally {
      writing = false;
      if (dirty) void flush();
    }
  }

  /** 标脏并延迟写盘（500ms 合并连点）。 */
  function save() {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 500);
    timer.unref?.();
  }

  /** 取一个对象 section；不存在 / 类型不对时初始化成 `fallback`。 */
  function section(name, fallback = {}) {
    if (data[name] === null || typeof data[name] !== 'object' || Array.isArray(data[name])) {
      data[name] = fallback;
    }
    return data[name];
  }

  return { data, save, flush, section };
}
