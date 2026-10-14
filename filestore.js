/**
 * 几个「原子写 / 尽力而为读」的小工具：记忆文件、转录日志、摘要状态都走它。
 *
 * 与 `util.js` 分开是因为这几个**会碰磁盘**：`util.js` 保持纯粹（可以被随意调用、
 * 无需清理），而这里每个函数的失败语义都不一样，值得单独放一处说清楚 ——
 * 尤其是「读不到就返回空/undefined，而不是抛错」这条，它决定了调用方不用处处 try。
 *
 * @module @qqbot/dsh-plugin-qq/filestore
 */
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';

/**
 * 把一个 JSON 对象原子地写进文件：先写同目录的临时文件再 rename。
 *
 * 记忆文件很小、写得也少，但「写到一半进程被杀」会留下一个半截 JSON —— 而它正是
 * 摘要 Agent 每次开工都要读的东西。rename 在同一个文件系统内是原子的。
 * @param absolute - 目标绝对路径。
 * @param payload - 可 JSON 序列化的值。
 */
export async function writeJsonAtomic(absolute, payload) {
  const temp = `${absolute}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, absolute);
}

/**
 * 把一段文本原子地写进文件（同上，用于 Markdown 记忆文件）。
 * @param absolute - 目标绝对路径。
 * @param text - 文件正文。
 */
export async function writeTextAtomic(absolute, text) {
  const temp = `${absolute}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, absolute);
}

/**
 * 把一段字节原子地写进文件（同一套临时文件 + rename）。
 *
 * 表情包是**二进制**且体量可能到几 MB，所以不能走 `writeTextAtomic`（那会把 Buffer
 * 按 utf8 编码一遍，写出来的是坏图）。不写编码参数 = 原样落盘。
 * @param absolute - 目标绝对路径。
 * @param bytes - 文件字节（Buffer / Uint8Array）。
 */
export async function writeBytesAtomic(absolute, bytes) {
  const temp = `${absolute}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, absolute);
}

/** 读取一个文本文件；不存在时返回 undefined（而不是抛错）。 */
export async function readTextOrUndefined(absolute) {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * 读一个 JSONL 转录文件；单行坏掉（写到一半被杀、手工编辑出错）时跳过那一行，
 * 不让一条坏记录把整个会话的历史变成读不出来。
 * @param absolute - 转录文件的绝对路径。
 * @returns 解析成功的记录数组。
 */
export async function readJsonl(absolute) {
  const text = await readTextOrUndefined(absolute);
  if (text === undefined) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 坏行直接跳过：转录是「尽力而为」的历史，不是账本。
    }
  }
  return out;
}

/** 列出一个目录下的文件名；目录不存在时返回空数组。 */
export async function readdirOrEmpty(absolute) {
  try {
    return await readdir(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}
