/**
 * `editor.js` 的单元测试：路径边界、唯一匹配替换、备份与 skill 读写。
 *
 * 这份文件是「受信写盘」的地基：工具层只做权限判断，真正能写到哪里由这里决定。
 * 所以测试全部在临时目录里跑，不碰仓库、也不碰 `~/.dsh`。
 *
 * 运行：node --test test/editor.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPatch,
  createEditor,
  sanitizeRelativePath,
  skillNameOk,
  writableTargetReason,
} from '../editor.js';

test('sanitizeRelativePath：只收工作目录内的相对路径', () => {
  assert.equal(sanitizeRelativePath('.qq-persona/STYLE.md'), '.qq-persona/STYLE.md');
  assert.equal(sanitizeRelativePath('.\\qq-persona\\STYLE.md'), 'qq-persona/STYLE.md');
  assert.equal(sanitizeRelativePath('./a//b.md'), 'a/b.md');
  for (const bad of ['', '   ', '/etc/passwd', 'C:\\Windows\\win.ini', '../outside.md', 'a/../../b.md']) {
    assert.throws(() => sanitizeRelativePath(bad), /不能为空|绝对路径|\.\./);
  }
});

test('writableTargetReason：扩展名白名单 + 敏感目录拒绝', () => {
  assert.equal(writableTargetReason('.qq-persona/PERSONA.md'), undefined);
  assert.equal(writableTargetReason('.dsh/skills/x/SKILL.md'), undefined);
  assert.match(writableTargetReason('.qq-memory/STICKERS.md') ?? '', /qq_memory/);
  assert.match(writableTargetReason('data/reminders.json') ?? '', /格式护栏/);
  assert.match(writableTargetReason('.qq-stickers/a.gif') ?? '', /缓存|扩展名/);
  assert.match(writableTargetReason('notes.png') ?? '', /文本文件/);
});

test('applyPatch：必须恰好出现一次', () => {
  assert.equal(applyPatch('a\nb\na', 'b', 'B'), 'a\nB\na');
  assert.equal(applyPatch('只有一处：睡觉', '睡觉', '起床'), '只有一处：起床');
  assert.equal(applyPatch('删除这段', '这段', ''), '删除');
  assert.throws(() => applyPatch('x', '', 'y'), /old_text 不能为空/);
  assert.throws(() => applyPatch('abc', 'z', 'y'), /没有出现/);
  assert.throws(() => applyPatch('a a', 'a', 'b'), /出现了 2 次/);
});

test('skillNameOk：单层小写目录名', () => {
  assert.equal(skillNameOk('qq-bot-notes'), true);
  assert.equal(skillNameOk('learn2'), true);
  assert.equal(skillNameOk('Learn'), false);
  assert.equal(skillNameOk('a/b'), false);
  assert.equal(skillNameOk('.hidden'), false);
  assert.equal(skillNameOk(''), false);
});

test('createEditor：写 / 改 / 备份 / 越界 / skill 全流程', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qqb-editor-cwd-'));
  const skills = await mkdtemp(join(tmpdir(), 'qqb-editor-skills-'));
  try {
    const editor = createEditor({ cwd, skillRoot: skills });

    // 写一份人设，再唯一匹配改一处。
    const wrote = await editor.write('.qq-persona/PERSONA.md', '名字：小助手\n自称：机器人\n');
    assert.equal(wrote.path, '.qq-persona/PERSONA.md');
    assert.ok(wrote.bytes > 0);
    await editor.patch('.qq-persona/PERSONA.md', '自称：机器人', '自称：机器人（睡觉时会闭嘴）');
    assert.match((await editor.read('.qq-persona/PERSONA.md')).content, /闭嘴/);

    // 两次写都要留备份。
    const history = await readdir(join(cwd, '.dsh', '.history'));
    assert.ok(history.filter((name) => name.endsWith('.bak')).length >= 1);

    // 越界与拒绝目录。
    await assert.rejects(() => editor.write('../outside.md', 'x'), /\.\./);
    await assert.rejects(() => editor.write('.qq-memory/STICKERS.md', 'x'), /qq_memory/);
    await assert.rejects(() => editor.read('nope.md'), /不存在/);

    // skill：外部目录、只有 SKILL.md。
    await mkdir(join(skills, 'qq-bot-notes'), { recursive: true });
    await writeFile(join(skills, 'qq-bot-notes', 'SKILL.md'), '# notes\n\n- 旧规则\n', 'utf8');
    assert.deepEqual(await editor.skillList(), ['qq-bot-notes']);
    const read = await editor.skillRead('qq-bot-notes');
    assert.match(read.content, /旧规则/);
    await editor.skillPatch('qq-bot-notes', '- 旧规则', '- 新规则');
    assert.match((await editor.skillRead('qq-bot-notes')).content, /新规则/);
    await editor.skillWrite('qq-bot-notes', '# notes\n\n- 整份重写\n');
    assert.match(await readFile(join(skills, 'qq-bot-notes', 'SKILL.md'), 'utf8'), /整份重写/);
    await assert.rejects(() => editor.skillRead('../../escape'), /不合法/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(skills, { recursive: true, force: true });
  }
});
