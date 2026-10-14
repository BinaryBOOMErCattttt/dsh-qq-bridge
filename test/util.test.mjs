/**
 * `util.js` 里那批纯函数的边界测试。
 *
 * 重点不是重复 `bridge.test.mjs` 已经验过的行为（会话 id 的契约、白名单解析、时段判定），
 * 而是几条**只在这个函数里成立、坏掉了不容易被发现**的规矩：
 *
 *   - `memoryRelativePath` 是 `qq_memory` 工具**唯一**的写边界（AGENTS.md §4.E）：
 *     `../`、绝对路径、以及「只是前缀相同」的兄弟目录都必须被拒。
 *   - `memorySlug` 决定磁盘上的目录名，改坏了等于所有人换一个目录去找记忆。
 *   - `apiKeyFingerprint` 是日志侧的唯一防线：**绝不能**输出完整 key。
 *   - `msUntilDailyHour` 刚过点时必须排到明天，否则摘要循环会原地反复醒。
 *
 * 时间相关的用例一律用 `new Date(...)` 的本地构造 + 本地格式化来对齐，
 * 这样任何时区下结论都一样（不写死 UTC 偏移）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apiKeyFingerprint,
  errorText,
  hourLabel,
  localDate,
  localStamp,
  memoryOneLine,
  memoryRelativePath,
  memorySlug,
  msUntilDailyHour,
  stickerFileName,
  visibleText,
} from '../util.js';

test('memoryRelativePath：目录内的路径原样通过（正斜杠、保留子目录）', () => {
  const base = '/tmp/mem/';
  assert.equal(memoryRelativePath(base, 'COGNITION.md'), 'COGNITION.md');
  assert.equal(memoryRelativePath(base, 'conversations/group-100000001/MEMORY.md'), 'conversations/group-100000001/MEMORY.md');
  assert.equal(memoryRelativePath(base, './a.md'), 'a.md', '开头的 ./ 要去掉');
  assert.equal(memoryRelativePath(base, 'a/./b.md'), 'a/b.md', '中间的 . 段要丢掉');
  assert.equal(memoryRelativePath(base, 'a//b.md'), 'a/b.md', '空段要丢掉');
  assert.equal(memoryRelativePath(base, 'a\\b.md'), 'a/b.md', '反斜杠也当分隔符（模型会写）');
  assert.equal(memoryRelativePath(base, '中文目录/记忆.md'), '中文目录/记忆.md');
});

test('memoryRelativePath：越界一律 undefined（这是唯一的写边界）', () => {
  const base = '/tmp/mem/';
  for (const raw of ['../evil.md', 'a/../../evil.md', '..', '', '   ', '/etc/passwd', '/tmp/mem/x.md']) {
    assert.equal(memoryRelativePath(base, raw), undefined, `必须拒绝: ${JSON.stringify(raw)}`);
  }
  // 只是前缀相同的兄弟目录：base 以分隔符结尾就是靠这一条守住的（`/tmp/mem/` vs `/tmp/mem2/`）。
  assert.equal(memoryRelativePath(base, '../mem2/x.md'), undefined);
});

test('memorySlug：会话 key → 磁盘目录名', () => {
  assert.equal(memorySlug('group:100000001'), 'group-100000001');
  assert.equal(memorySlug('private:100000002'), 'private-100000002');
  // 冒号在部分文件系统上不合法，折成 `-`；其余非法字符同理。
  assert.equal(memorySlug('a b/c'), 'a-b-c');
  assert.equal(memorySlug('...hidden'), 'hidden', '开头的点会让它变成隐藏目录，要去掉');
  assert.equal(memorySlug('keep.dots-and_underscores'), 'keep.dots-and_underscores');
  // 折完什么都不剩时给一个固定名字，而不是空串（空目录名会直接报错）。
  assert.equal(memorySlug(''), 'unknown');
  assert.equal(memorySlug(null), 'unknown');
  assert.equal(memorySlug('///'), 'unknown');
  // 超长 key 要截断：目录名有长度上限，且不该让一条消息撑爆文件名。
  assert.equal(memorySlug('g'.repeat(500)).length, 120);
});

test('msUntilDailyHour：刚过点必须排到明天，不能原地反复醒', () => {
  const day = 24 * 60 * 60 * 1000;
  // 差一秒到点：等一秒。
  assert.equal(msUntilDailyHour(4, new Date(2024, 0, 1, 3, 59, 59).getTime()), 1000);
  // 正好在点上：这一刻不能再触发一次，排到明天。
  assert.equal(msUntilDailyHour(4, new Date(2024, 0, 1, 4, 0, 0).getTime()), day);
  // 刚过点一毫秒：同样排到明天。
  assert.equal(msUntilDailyHour(4, new Date(2024, 0, 1, 4, 0, 0, 1).getTime()), day - 1);
  // 任何时候都不小于 1 秒（下限是刻意的，见函数注释）。
  assert.ok(msUntilDailyHour(0, new Date(2024, 0, 1, 0, 0, 0).getTime()) >= 1000);
});

test('localDate / localStamp / hourLabel：本地时间的格式', () => {
  const at = new Date(2024, 5, 7, 8, 9, 10).getTime();
  assert.equal(localDate(at), '2024-06-07');
  assert.equal(localStamp(at), '2024-06-07 08:09:10');
  assert.equal(hourLabel(4), '04:00');
  assert.equal(hourLabel(23), '23:00');
  // 两位补零是给「按日期切文件」「按字符串排序」用的，不能省。
  assert.match(localDate(new Date(2024, 0, 2).getTime()), /^\d{4}-\d{2}-\d{2}$/);
});

test('errorText：多行堆栈压成一行，空消息给一句兜底', () => {
  assert.equal(errorText(new Error('第一行\n    at 某处 (x.js:1)\n第二行')), '第一行 at 某处 (x.js:1) 第二行');
  // 空消息与纯空白才落到兜底那句。
  assert.equal(errorText(new Error('')), 'unknown error');
  assert.equal(errorText(new Error('   \n ')), 'unknown error');
  assert.equal(errorText('随便一个字符串'), '随便一个字符串');
  // 这里钉的是**现状**：`String(undefined)` 会得到字面量 "undefined"，
  // 兜底那句只对空串生效。已知的小瑕疵（日志里可能出现一个 "undefined"），
  // 但改它属于行为变更，不在这次纯搬运里顺手做 —— 先记下来，别让后来人以为是巧合。
  assert.equal(errorText(undefined), 'undefined');
  // 上限 200：QQ 消息里不能糊一大段堆栈进去。
  assert.equal(errorText(new Error('x'.repeat(500))).length, 200);
});

test('visibleText：只收 text 块，其余（工具调用/思考）忽略', () => {
  assert.equal(visibleText([{ type: 'text', text: '一' }, { type: 'tool-call' }, { type: 'text', text: '二' }]), '一\n二');
  assert.equal(visibleText([]), '');
  assert.equal(visibleText(undefined), '');
  assert.equal(visibleText('不是数组'), '');
});

test('memoryOneLine：换行折成空格（记忆是「一行一条事实」）', () => {
  assert.equal(memoryOneLine('第一行\n第二行\t第三行'), '第一行 第二行 第三行');
  assert.equal(memoryOneLine('  '), '');
  assert.equal(memoryOneLine(undefined), '');
});

test('apiKeyFingerprint：日志里绝不能出现完整 key', () => {
  const key = 'sk-abcdef1234567890';
  const shown = apiKeyFingerprint(key);
  assert.ok(!shown.includes(key), '完整 key 不能出现在指纹里');
  assert.ok(!shown.includes(key.slice(6)), '摘要之外的部分也不能露出来');
  assert.match(shown, /^sk-abc…#[0-9a-f]{8}$/);
  // 同一个 key 永远同一个指纹（用来确认「池子里两行是不是同一个 key」）。
  assert.equal(apiKeyFingerprint(key), shown);
  // 短 key 不露头（太短的头几乎等于整个 key）。
  assert.match(apiKeyFingerprint('short'), /^#[0-9a-f]{8}$/);
  assert.match(apiKeyFingerprint(''), /^#[0-9a-f]{8}$/);
});

// `stickerFileName` 是 `qq_save_sticker` 的写边界（见 AGENTS.md §4.E 的同一条道理）：
// 名字来自 QQ 那头（模型的转述），所以「能不能写出去一个目录之外的文件」全部取决于它。
// 它同时也是每轮提示词里那串候选名字的来源，所以「一个名字 = 一个文件」必须成立。
test('stickerFileName：目录被丢掉、扩展名以真实格式为准', () => {
  assert.equal(stickerFileName('委屈', 'gif'), '委屈.gif');
  assert.equal(stickerFileName('委屈.gif', 'gif'), '委屈.gif', '模型又把扩展名写了一遍，不能变成 委屈.gif.gif');
  assert.equal(stickerFileName('委屈.png', 'gif'), '委屈.gif', '模型写的后缀是错的，按字节嗅出来的格式算');
  assert.equal(stickerFileName('.qq-stickers/委屈', 'png'), '委屈.png', '整串路径当名字传进来时只取最后一段');
  assert.equal(stickerFileName(' C:\\stickers\\笑死 ', 'jpg'), '笑死.jpg', '反斜杠同样是分隔符');
  assert.equal(stickerFileName('摸摸头', 'webp'), '摸摸头.webp');
});

test('stickerFileName：清洗掉非法字符，但绝不留下能越界的名字', () => {
  // 目录部分一律丢掉，所以「往上跳」在结果里根本不存在。
  assert.equal(stickerFileName('../../etc/passwd', 'png'), 'passwd.png');
  assert.equal(stickerFileName('a/../../b.png', 'png'), 'b.png');
  assert.equal(stickerFileName('a:b*c?d|e', 'png'), 'abcde.png');
  assert.equal(stickerFileName('  笑 死  ', 'png'), '笑 死.png', '中间空格保留、首尾去掉');
  // Windows 不允许结尾是点/空格，开头是点会变成隐藏文件（列目录时被跳过，等于存了看不见）。
  assert.equal(stickerFileName('...笑死...', 'png'), '笑死.png');
  assert.equal(stickerFileName(' . 笑死 ', 'png'), '笑死.png');
  assert.equal(stickerFileName('笑\u0000死\n', 'png'), '笑死.png');
});

test('stickerFileName：清洗完没剩下东西、或格式不认识时 undefined（调用方据此报错）', () => {
  for (const raw of ['', '   ', '..', '../', '////', '.', '...', '\u0000']) {
    assert.equal(stickerFileName(raw, 'png'), undefined, `必须拒绝: ${JSON.stringify(raw)}`);
  }
  assert.equal(stickerFileName('笑死', 'bmp'), undefined, '只认这条图片链路支持的四种格式');
  assert.equal(stickerFileName('笑死', ''), undefined);
  // 名字要进每轮提示词，所以长度封顶（超长名是纯 token 开销）。
  assert.equal(stickerFileName('笑'.repeat(80), 'png').length, 60 + '.png'.length);
});
