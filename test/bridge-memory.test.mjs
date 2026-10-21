/**
 * 集成测试分册：长期记忆（转录 / 记忆文件 / 摘要 / 滚档 / scope）。
 *
 * 夹具（假 OneBot 服务端 + 假 Harness Host + boot / until / 消息构造）在
 * `test/harness.mjs`；本文件只放这一主题的用例，可单独跑：
 * `node --test bridge-memory.test.mjs`。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionIdFor } from '../index.js';
import { promptText, turnContextText, until, untilInbox, privateMessage, groupMessage, mention, settle, bootMemory, msUntilHour, readMemory, waitForDigestRecord, localDateOf } from './harness.mjs';
import { cleanupBoots } from './harness.mjs';

after(async () => { await cleanupBoots(); });


/**
 * 一条入站消息落一行转录，而且**没被 @ 的群消息也算**：长期记忆的原料正是那些
 * 没人跟机器人说话的闲聊。同时验证「闲聊不会凭空建出会话记录」这条旧不变量。
 */
test('every incoming message is appended to the transcript, including ambient group chatter', async () => {
  const { onebot, host, cwd } = await bootMemory();
  onebot.push(privateMessage('第一条'));
  onebot.push(groupMessage([{ type: 'text', data: { text: '他们聊他们的' } }], { messageId: 7001, userId: 10001, card: 'soyo' }));
  onebot.push(mention('机器人你好'));

  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  // 转录是后台写盘（不挡事件热路径），所以这里等它落下来。目录名是 key 去掉冒号：
  // group:100000001 → group-100000001（见 memorySlug）。
  const logFile = join(cwd, '.qq-memory', 'conversations', 'private-100000002', 'log', `${localDateOf()}.jsonl`);
  await until(() => existsSync(logFile), 'the private transcript to be written');
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '第一条');
  assert.equal(lines[0].addressed, true);

  const groupLog = join(cwd, '.qq-memory', 'conversations', 'group-100000001', 'log', `${localDateOf()}.jsonl`);
  // 两条都记：一条是没人 @ 的闲聊（addressed: false），一条是被叫到的。
  // 转录是后台串行写盘的，两条不一定同一瞬间落地，所以这里等它写全再看内容。
  const groupLines = await until(async () => {
    if (!existsSync(groupLog)) return undefined;
    const parsed = (await readFile(groupLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return parsed.length >= 2 ? parsed : undefined;
  }, 'both group messages to be written to the transcript');
  assert.deepEqual(groupLines.map((line) => line.addressed), [false, true]);
  assert.equal(groupLines[0].name, 'soyo');

  // 旧的硬约束不变量：没被 @ 的群消息不该让这个群出现在「处理过的会话」表里。
  const list = await host.tools.get('qq_list_conversations').execute({}, {});
  assert.deepEqual(list.sessions.map((session) => session.conversation), ['private:100000002', 'group:100000001']);
  assert.equal(agent.id, list.sessions[0].session_id);
});


/** qq_transcript 的 list / read / search 三个动作，以及「默认就是当前会话」。 */
test('qq_transcript lists conversations and reads and searches their records', async () => {
  const { onebot, host } = await bootMemory();
  onebot.push(privateMessage('周六去看那个展吗'));
  onebot.push(privateMessage('展叫什么来着'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  const tool = host.tools.get('qq_transcript');
  assert.ok(tool, 'qq_transcript should be registered');
  // 等两条都进转录（第二条提交后才算完一轮，但转录是先写的）。
  await until(async () => {
    const value = await tool.execute({ action: 'read' }, { agent });
    return value.returned >= 2 ? value : undefined;
  }, 'both private messages to be recorded');

  const listed = await tool.execute({ action: 'list' }, {});
  assert.equal(listed.lines.length, 1);
  assert.equal(listed.lines[0].conversation, 'private:100000002');
  assert.equal(listed.lines[0].messages, 2);

  // 不传 conversation 时默认就是调用它的那个 Agent 的会话。
  const read = await tool.execute({ action: 'read', limit: 1 }, { agent });
  assert.equal(read.returned, 1);
  assert.equal(read.truncated, true);
  assert.equal(read.lines[0].text, '展叫什么来着');
  assert.equal(read.lines[0].user, 'iroha');

  const found = await tool.execute({ action: 'search', query: '展' }, { agent });
  assert.equal(found.returned, 2);
  const missing = await tool.execute({ action: 'search', query: '不存在的词' }, { agent });
  assert.equal(missing.returned, 0);
  await assert.rejects(() => tool.execute({ action: 'search' }, { agent }), /"query" is required/);
});


/** qq_memory：追加、读回、覆盖，以及「写不出记忆目录」这条边界。 */
test('qq_memory appends, reads back and overwrites, and refuses paths outside the memory directory', async () => {
  const { onebot, host, cwd } = await bootMemory();
  onebot.push(privateMessage('你好'));
  const agent = await until(() => host.list.created[0], 'the conversation Agent to be created');
  const tool = host.tools.get('qq_memory');
  assert.ok(tool, 'qq_memory should be registered');

  const target = 'conversations/group-100000001/MEMORY.md';
  const written = await tool.execute({ action: 'append', path: target, text: '- 群主叫kaguya，周六常组织打本' }, {});
  assert.equal(written.action, 'append');
  assert.match(await readMemory(cwd, target), /群主叫kaguya/);

  await tool.execute({ action: 'append', path: target, text: '- 群里不喜欢被叫「大佬」' }, {});
  const read = await tool.execute({ action: 'read', path: target }, {});
  assert.match(read.text, /群主叫kaguya/);
  assert.match(read.text, /不喜欢被叫/);
  assert.match(read.text, /^\s+1 \| /m, 'read should number the lines');

  // 整份重写把条目砍掉一大截要 `force`（与认知库 / 表情包目录同一条护栏：
  // 模型漏抄几行时文件照样「写成功」，护栏是唯一能拦住它的地方）。
  await assert.rejects(
    () => tool.execute({ action: 'write', path: target, text: '- 只留这一条' }, {}),
    /keep only 1 of 2 entries/,
  );
  const overwritten = await tool.execute({ action: 'write', path: target, text: '- 只留这一条', force: true }, {});
  assert.equal(overwritten.action, 'write');
  assert.doesNotMatch(await readMemory(cwd, target), /群主叫kaguya/);

  const found = await tool.execute({ action: 'search', path: target, query: '只留' }, {});
  assert.equal(found.returned, 1);

  const files = await tool.execute({ action: 'list' }, {});
  assert.ok(files.files.some((file) => file.endsWith(target)), 'list should show the memory file');

  // 边界：绝对路径、`..`、以及写到记忆目录之外都必须被拒 —— 记忆工具是宿主平面的，
  // QQ 消息是拿不到它的，但摘要 Agent 会照着模型输出的路径写，路径必须由插件说了算。
  await assert.rejects(() => tool.execute({ action: 'write', path: '../evil.md', text: 'x' }, {}), /not inside the memory directory/);
  await assert.rejects(() => tool.execute({ action: 'write', path: '/tmp/evil.md', text: 'x' }, {}), /not inside the memory directory/);
  assert.equal(existsSync(join(cwd, 'evil.md')), false);
});


/** 定时器每天醒一次（默认 04:00），醒来帮会话摘要一次并记下进度。 */
test('qq_memory upsert / remove：逐条写认知与表情包，整份重写丢行会被挡住', async () => {
  const { host, cwd } = await bootMemory();
  const tool = host.tools.get('qq_memory');

  // 认知：新增 → 按 type 归节；同一条再写一次是「替换」，不是多加一行。
  const added = await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '蚌埠住了', meaning: '绷不住了', type: '谐音', variants: '绷不住/绷' }, {});
  assert.equal(added.action, 'upsert');
  assert.match(added.note, /added/);
  let cognition = await readMemory(cwd, 'COGNITION.md');
  assert.match(cognition, /## 谐音与变体\n- 蚌埠住了（变体：绷不住 \/ 绷）｜绷不住了/);

  const replaced = await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '蚌埠住了', meaning: '忍不住笑了', confidence: '存疑' }, {});
  assert.match(replaced.note, /replaced/);
  cognition = await readMemory(cwd, 'COGNITION.md');
  assert.equal((cognition.match(/蚌埠住了/g) ?? []).length, 1, '同一条不能变成两行');
  assert.match(cognition, /置信：存疑/);

  // 追加时又贴了一遍同一个标题：落盘时合并，文件里只留一个。
  await tool.execute({ action: 'append', path: 'COGNITION.md', text: '## 黑话与缩写\n- 典｜讽刺「经典操作」' }, {});
  await tool.execute({ action: 'append', path: 'COGNITION.md', text: '## 黑话与缩写\n- 急了｜破防了' }, {});
  cognition = await readMemory(cwd, 'COGNITION.md');
  assert.equal((cognition.match(/^## 黑话与缩写$/gm) ?? []).length, 1, '重复标题必须被合并');
  assert.match(cognition, /典｜/);
  assert.match(cognition, /急了｜/);

  const removed = await tool.execute({ action: 'remove', path: 'COGNITION.md', name: '蚌埠住了' }, {});
  assert.match(removed.note, /removed/);
  assert.doesNotMatch(await readMemory(cwd, 'COGNITION.md'), /蚌埠住了/);

  // 表情包：upsert 一条进「已收藏」，名字与路径由工具保证格式。
  await tool.execute({ action: 'upsert', path: 'STICKERS.md', name: '无语', meaning: '无语、懒得吐槽', image: '.qq-stickers/无语.gif' }, {});
  assert.match(await readMemory(cwd, 'STICKERS.md'), /## 已收藏\n- 无语/);

  // 护栏：整份重写把条目砍掉一大截 → 拒绝；`force: true` 才放行。
  await assert.rejects(
    () => tool.execute({ action: 'write', path: 'STICKERS.md', text: '# 表情包目录\n\n## 已收藏\n' }, {}),
    /keep only 0 of 1 entries/,
  );
  const forced = await tool.execute({ action: 'write', path: 'STICKERS.md', text: '# 表情包目录\n\n## 已收藏\n', force: true }, {});
  assert.equal(forced.action, 'write');

  // 解析不了的行：read 直接点出来（否则它永远不进提示词，谁都不会去修）。
  await tool.execute({ action: 'write', path: 'COGNITION.md', text: '# 公共认知\n\n## 黑话与缩写\n- 只有一段没有竖线\n', force: true }, {});
  const read = await tool.execute({ action: 'read', path: 'COGNITION.md' }, {});
  assert.match(read.note ?? '', /不会.*注入|不会被注入/);

  // 每次写入都把旧版本留在 `.history/` 里：整份重写写坏了还能人工翻回去。
  const history = await readdir(join(cwd, '.qq-memory', '.history')).catch(() => []);
  assert.ok(history.length > 0, '写前必须留历史版本');
  assert.ok(history.some((name) => name.startsWith('COGNITION.md.')), history.join('|'));
});


/** 定时器每天醒一次（默认 04:00），醒来帮会话摘要一次并记下进度。 */
test('a digest sweep summarizes a conversation that has something new', async () => {
  // `apiKeyRotate: false`：这条用例要数清楚「挂着几个定时器、排到几点」，
  // 而 API key 轮换默认开着、也排在 04:00，会一起出现在这张表里。
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 2, apiKeyRotate: false });
  onebot.push(privateMessage('第一条'));
  onebot.push(privateMessage('第二条'));
  await untilInbox(host, 1, 'the conversation Agent to be created');

  // 定时器是每天一次的「下一个 04:00」：不是固定周期，所以间隔必须落在
  // (0, 24h] 里，且大致等于「距下一个整点还有多久」。
  const intervals = host.list.timers.live('intervals');
  assert.equal(intervals.length, 1, 'the daily digest timer should be registered');
  const armed = intervals[0].delay;
  assert.ok(armed > 0 && armed <= 24 * 60 * 60 * 1000, `delay should be within a day, got ${armed}`);
  assert.ok(Math.abs(armed - msUntilHour(4)) < 5000, `delay should point at the next 04:00, got ${armed}`);

  host.list.timers.fireInterval();

  const record = await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(record.lastLines, 2);
  assert.equal(record.lastDigestDate, localDateOf(), 'the digest should be recorded under today\'s date');

  // 摘要 Agent 是一个**独立会话**（不是那个正在聊天的会话），它拿到的正文是转录窗口。
  const digestAgent = host.list.created.find((agent) => agent.id !== host.list.created[0].id);
  assert.ok(digestAgent, 'a separate digest session should have been created');
  const instruction = digestAgent.inbox[digestAgent.inbox.length - 1].content[0].text;
  assert.match(instruction, /private:100000002/);
  assert.match(instruction, /第一条/);
  assert.match(instruction, /第二条/);

  // 摘要会话的系统提示点明它是后台记忆维护会话，并指定了要处理的会话。
  const digestPromptText = promptText(host, 'qq-bridge:digest');
  assert.match(digestPromptText, /记忆维护会话/);
  assert.match(digestPromptText, /message-digest/);

  // 一天至多一次：即使定时器又醒一次、这期间又来了两条（远超 digestMinLines），
  // 同一个会话今天也不该再被摘要一遍。
  onebot.push(privateMessage('第三条'));
  onebot.push(privateMessage('第四条'));
  await settle(80);
  const before = await readMemory(cwd, 'digest.json');
  const digests = host.list.created.length;
  host.list.timers.fireInterval();
  await settle(200);
  assert.equal(await readMemory(cwd, 'digest.json'), before);
  assert.equal(host.list.created.length, digests, 'a conversation is digested at most once a day');
});


/** 消息太少时不该白跑一次模型调用 —— 留到明天，什么都不写。 */
test('a digest sweep leaves a quiet conversation for later', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 20 });
  onebot.push(privateMessage('就一句'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  host.list.timers.fireInterval();
  await settle(200);
  assert.equal(host.list.created.length, 1, 'no digest session should be created for a single message');
  // 没攒够就什么都不记（连 digest.json 都不该出现），明天再看 —— 消息不会丢，
  // dirty 计数一直在。
  assert.equal(existsSync(join(cwd, '.qq-memory', 'digest.json')), false);
});


/**
 * 错过了摘要点就补课：进程在 04:00 那一刻没跑（重启了），重启后第一个说话的人
 * 一开口就把这条会话补摘要一次 —— 而不是等到明天。
 *
 * 这里把 `digestAtHour` 设成 0（今天必然已经过了这个点），于是「补课」是确定性的，
 * 不依赖测试在一天里的哪个时刻跑。
 */
test('a conversation that missed the digest hour is caught up on its next message', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  onebot.push(privateMessage('重启之后的第一句'));
  await until(() => host.list.created.length > 1, 'the catch-up digest session to be created')
    .catch((error) => {
      throw new Error(`${error.message} | created=${host.list.created.length} warnings=${JSON.stringify(host.list.warnings)} timers=${host.list.timers.live('intervals').length} tools=${[...host.tools.keys()].join(',')}`);
    });
  const record = await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(record.lastDigestDate, localDateOf(), 'the catch-up should be recorded under today');
  assert.equal(record.lastLines, 1);
});


/** 补课是每次启动一轮，不是每条消息一轮。 */
test('the catch-up sweep runs once per process, not once per message', async () => {
  const { onebot, host } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  onebot.push(privateMessage('第一句'));
  await until(() => host.list.created.length > 1, 'the first catch-up digest');
  const after = host.list.created.length;
  onebot.push(privateMessage('第二句'));
  await settle(200);
  assert.equal(host.list.created.length, after, 'no second digest session should be created');
});


/** 关掉 digestCatchUp 时，错过摘要点就只在明天的点上摘要。 */
test('digestCatchUp: false leaves a missed digest until the next daily run', async () => {
  const { onebot, host } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: false });
  onebot.push(privateMessage('今天不补'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  await settle(200);
  assert.equal(host.list.created.length, 1, 'no digest session without a timer tick');
});


/** `INDEX.md` 会出现在渠道提示里，好让模型「知道自己记得什么」。 */
test('the channel prompt carries the global INDEX.md once it exists', async () => {
  const { onebot, host, cwd } = await bootMemory();
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });
  await writeFile(join(cwd, '.qq-memory', 'INDEX.md'), '- kaguya：群主，周六常组织打本', 'utf8');
  onebot.push(privateMessage('在吗'));
  // 索引是异步刷新进缓存的（提示词装配是同步的），所以第一次装配可能还是空的。
  const agent = await until(() => host.list.created[0], 'the first Agent');
  const text = await until(() => {
    const current = turnContextText(agent);
    return current.includes('群主，周六常组织打本') ? current : undefined;
  }, 'the memory index to reach the channel prompt');
  assert.match(text, /和当前话题相关的记忆/);
  assert.match(text, /### 全局索引（INDEX.md）/);
});


/**
 * 「只给一次」的端到端回归：同一个会话的第二条消息不再重发同一段记忆。
 *
 * 记忆块每轮都跟着 user message 投递、并且一直留在历史里 —— 人物表 + 索引 + 词汇表
 * 每轮重发一遍，三十几轮就把上下文顶到宿主的压缩门槛，压缩会把整段聊天改写成一份
 * 英文技术备忘录（群里看到的就是「越聊越人机」）。账本在 `memory.js` 的 `recallLedger`。
 */
test('the memory block is delivered once per session round, not on every turn', async () => {
  const { onebot, host, cwd } = await bootMemory();
  await mkdir(join(cwd, '.qq-memory'), { recursive: true });
  await writeFile(join(cwd, '.qq-memory', 'INDEX.md'), '- kaguya：群主，周六常组织打本', 'utf8');
  onebot.push(privateMessage('在吗'));
  const agent = await untilInbox(host, 1);
  await until(
    () => turnContextText(agent).includes('群主，周六常组织打本'),
    'the memory index on the first turn',
  );

  onebot.push(privateMessage('还在吗'));
  await untilInbox(host, 2);
  const second = turnContextText(agent);
  assert.doesNotMatch(second, /和当前话题相关的记忆/, '第二条消息不该再发一整段记忆');
  assert.doesNotMatch(second, /群主，周六常组织打本/, '给过的索引不再重复');
});


/**
 * 检索式注入：消息里原样出现的写法（哪怕条目没有日期）必须进提示词。
 *
 * 这是设计 §1.2 的真实事故回归：那条老梗在 COGNITION.md 里写得完整，但没有「首见日期」，
 * 旧实现把它当最旧，于是永远进不了热梗段。现在它由「消息里出现 → 命中」捞出来，
 * 不看日期、也不看它在文件里排第几。
 */
test('a no-date cognition row is recalled when the incoming message uses it', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const memoryDir = join(cwd, '.qq-memory');
  await mkdir(memoryDir, { recursive: true });
  const dated = Array.from({ length: 20 }, (_, index) => `- 新梗${index}｜刚学的｜2026-10-${String((index % 9) + 10).padStart(2, '0')}`).join('\n');
  await writeFile(
    join(memoryDir, 'COGNITION.md'),
    `# 公共认知\n\n## 黑话与缩写\n${dated}\n- 老说法｜很久以前学的，从来没写日期\n`,
    'utf8',
  );
  onebot.push(privateMessage('你懂那个老说法是什么意思吗'));
  const agent = await until(() => host.list.created[0], 'the private Agent');
  const text = await until(() => {
    const current = turnContextText(agent);
    return current.includes('老说法 —— 很久以前学的') ? current : undefined;
  }, 'the no-date cognition row to reach the prompt');
  assert.match(text, /老说法 —— 很久以前学的/);
  assert.match(text, /词汇表（全部梗的写法/);
});


/** 群隔离：另一个群的 MEMORY.md 不会出现在这个群的提示词里（连候选都不是）。 */
test('another group\'s MEMORY.md never leaks into this group\'s prompt', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const memoryDir = join(cwd, '.qq-memory');
  await mkdir(join(memoryDir, 'conversations', 'group-200000001'), { recursive: true });
  await writeFile(
    join(memoryDir, 'conversations', 'group-200000001', 'MEMORY.md'),
    '# 另一个群\n\n## 事实与事件\n- 另一个群的暗号｜只有那个群知道\n',
    'utf8',
  );
  onebot.push(mention('另一个群的暗号是什么'));
  await until(() => host.list.created[0], 'the group Agent');
  const text = promptText(host, 'qq-bridge:channel');
  assert.doesNotMatch(text, /另一个群的暗号/);
});


/** 私聊写入闸门：私聊会话对全局 COGNITION.md / PEOPLE.md 的写请求一律拒绝。 */
test('a private chat cannot write the global COGNITION.md or PEOPLE.md', async () => {
  const { onebot, host, cwd } = await bootMemory();
  const tool = host.tools.get('qq_memory');
  onebot.push(privateMessage('私聊里聊点事'));
  const privateId = sessionIdFor('private:100000002');
  const privateAgent = await until(() => host.list.created.find((agent) => agent.id === privateId), 'the private Agent');
  await assert.rejects(
    () => tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '私聊梗', meaning: '私聊里学的说法' }, { agent: privateAgent }),
    /private chat must not write/,
  );
  await assert.rejects(
    () => tool.execute({ action: 'append', path: 'PEOPLE.md', text: '- 某人｜私聊里知道的人' }, { agent: privateAgent }),
    /private chat must not write/,
  );
  assert.equal(existsSync(join(cwd, '.qq-memory', 'COGNITION.md')), false, '被拒绝的写入不能留下文件');
  assert.equal(existsSync(join(cwd, '.qq-memory', 'PEOPLE.md')), false);

  // 同一段私聊写自己的 MEMORY.md 是允许的 —— 闸门只挡「升级到全局」。
  const own = await tool.execute(
    { action: 'upsert', path: 'conversations/private-100000002/MEMORY.md', name: '私聊事实', meaning: '只有这段私聊知道', section: '事实与事件' },
    { agent: privateAgent },
  );
  assert.equal(own.action, 'upsert');
  assert.match(await readMemory(cwd, 'conversations/private-100000002/MEMORY.md'), /私聊事实｜只有这段私聊知道/);

  // 对照：群会话写同一个全局文件是允许的（闸门不是一刀切）。
  onebot.push(mention('群里也说一个梗'));
  const groupId = sessionIdFor('group:100000001');
  const groupAgent = await until(() => host.list.created.find((agent) => agent.id === groupId), 'the group Agent');
  await tool.execute({ action: 'upsert', path: 'COGNITION.md', name: '公共梗', meaning: '群里公开说的' }, { agent: groupAgent });
  assert.match(await readMemory(cwd, 'COGNITION.md'), /公共梗｜群里公开说的/);
  // 人物表与热层记忆也支持逐条 upsert（新的结构化路径）。
  const person = await tool.execute(
    { action: 'upsert', path: 'PEOPLE.md', name: 'kaguya', qq: '100000001', aliases: 'soyo', meaning: '群主，周六常组织打本' },
    { agent: groupAgent },
  );
  assert.equal(person.note, 'added in «人物»');
  assert.match(await readMemory(cwd, 'PEOPLE.md'), /kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本/);
  const fact = await tool.execute(
    { action: 'upsert', path: 'conversations/group-100000001/MEMORY.md', name: '周五固定开黑', meaning: '晚上八点', section: '惯例与偏好', date: '2026-10-18' },
    { agent: groupAgent },
  );
  assert.equal(fact.action, 'upsert');
  assert.match(await readMemory(cwd, 'conversations/group-100000001/MEMORY.md'), /## 惯例与偏好\n- 周五固定开黑｜晚上八点｜首见 2026-10-18/);
});


/**
 * 私聊摘要不升级：摘要 Agent 在私聊那一轮里对全局文件的写同样被拒绝，
 * 新事实只能落进那个私聊的 MEMORY.md。
 *
 * 摘要 Agent 不是任何 QQ 会话的 Agent（不在 sessionIndex 里），所以这条用例同时钉住
 * 「`digestTarget` 把被摘要的会话传进写入闸门」这条实现细节。
 */
test('a private digest cannot promote facts into COGNITION.md or PEOPLE.md', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestAtHour: 0, digestMinLines: 1, digestCatchUp: true });
  const digestId = sessionIdFor('bridge:digest');
  const errors = [];
  host.list.onFollowup = async (agent) => {
    if (agent.id !== digestId) return;
    const tool = host.tools.get('qq_memory');
    for (const path of ['COGNITION.md', 'PEOPLE.md']) {
      try {
        await tool.execute({ action: 'upsert', path, name: '私聊里学的', meaning: '只在这段私聊成立', qq: '123456' }, { agent });
      } catch (error) {
        errors.push(String(error?.message ?? error));
      }
    }
    await tool.execute(
      { action: 'upsert', path: 'conversations/private-100000002/MEMORY.md', name: '私聊事实', meaning: '只留在这段私聊', section: '事实与事件' },
      { agent },
    );
  };
  onebot.push(privateMessage('私聊里说了个只有我俩知道的事'));
  await waitForDigestRecord(cwd, 'private:100000002');
  assert.equal(errors.length, 2, `两个全局写入都该被拒绝，实际：${errors.join(' | ')}`);
  assert.ok(errors.every((message) => /private chat must not write/.test(message)), errors.join(' | '));
  assert.equal(existsSync(join(cwd, '.qq-memory', 'COGNITION.md')), false, '私聊摘要不能创建 COGNITION.md');
  assert.equal(existsSync(join(cwd, '.qq-memory', 'PEOPLE.md')), false, '私聊摘要不能创建 PEOPLE.md');
  assert.match(await readMemory(cwd, 'conversations/private-100000002/MEMORY.md'), /私聊事实｜只留在这段私聊/);
});


/**
 * 滚档：热层超过阈值时，最不活跃的条目先进 archive/、再从热层删掉；search 仍然搜得到。
 */
test('memory rollover archives the least active rows instead of deleting them', async () => {
  const { onebot, host, cwd } = await bootMemory({ memoryFileMaxBytes: 4096, memoryArchiveRatio: 0.5, digestCatchUp: false });
  const tool = host.tools.get('qq_memory');
  onebot.push(privateMessage('你好'));
  const privateId = sessionIdFor('private:100000002');
  const agent = await until(() => host.list.created.find((item) => item.id === privateId), 'the private Agent');
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(`- 事实${index}｜一句话事实一句话事实｜首见 2026-10-0${(index % 9) + 1}`);
  }
  const markdown = `# 记忆\n\n## 事实与事件\n${rows.join('\n')}\n`;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  assert.ok(bytes > 2048 && bytes < 4096, `测试数据要落在阈值与上限之间，实际 ${bytes}`);
  await tool.execute({ action: 'write', path: 'conversations/private-100000002/MEMORY.md', text: markdown }, { agent });

  const archiveDir = join(cwd, '.qq-memory', 'conversations', 'private-100000002', 'archive');
  const archived = await until(async () => {
    if (!existsSync(archiveDir)) return undefined;
    const files = (await readdir(archiveDir)).filter((name) => name.endsWith('.md'));
    if (files.length === 0) return undefined;
    return { files, text: await readFile(join(archiveDir, files[0]), 'utf8') };
  }, 'the archive file to appear');

  const hot = await readMemory(cwd, 'conversations/private-100000002/MEMORY.md');
  assert.ok(Buffer.byteLength(hot, 'utf8') <= 2048, `热层要滚回阈值以下，实际 ${Buffer.byteLength(hot, 'utf8')}`);
  assert.doesNotMatch(hot, /见 archive|更早的/, '热层里不许写指针行');
  const hotRows = hot.split('\n').filter((line) => /^- /.test(line.trim())).length;
  const archivedRows = archived.text.split('\n').filter((line) => /^- /.test(line.trim())).length;
  assert.equal(hotRows + archivedRows, 40, '滚档只搬不删：条目总数守恒');

  // 冷层仍然搜得到（qq_memory search 覆盖 archive/）。
  const found = await tool.execute({ action: 'search', path: 'conversations/private-100000002/MEMORY.md', query: '事实0' }, { agent });
  assert.ok(found.returned > 0, '归档的条目必须仍然能搜到');
  assert.match(found.text, /archive\//);
  const listed = await tool.execute({ action: 'list' }, {});
  assert.ok(listed.files.some((file) => file.includes('/archive/')), `list 要能列出冷层，实际：${listed.files.join(' | ')}`);
});


/**
 * 归档写失败 → 热层原样不动：宁可暂时超一点，也不丢条目。
 *
 * 这里把 `archive/` 这个路径先占成**普通文件**，`mkdir` 就会失败 —— 用来复现磁盘权限 /
 * 路径被占住那一类真实故障。断言的是「热层一条不少」，不是「有没有报错」。
 */
test('a failed archive write leaves the hot layer untouched', async () => {
  const { onebot, host, cwd } = await bootMemory({ memoryFileMaxBytes: 4096, memoryArchiveRatio: 0.5 });
  onebot.push(privateMessage('你好'));
  const privateId = sessionIdFor('private:100000002');
  const agent = await until(() => host.list.created.find((item) => item.id === privateId), 'the private Agent');
  const convDir = join(cwd, '.qq-memory', 'conversations', 'private-100000002');
  await mkdir(convDir, { recursive: true });
  // 占住 archive/ 这个路径：rollover 的 mkdir 会失败。
  await writeFile(join(convDir, 'archive'), 'blocked', 'utf8');
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(`- 事实${index}｜一句话事实一句话事实｜首见 2026-10-0${(index % 9) + 1}`);
  }
  const markdown = `# 记忆\n\n## 事实与事件\n${rows.join('\n')}\n`;
  assert.ok(Buffer.byteLength(markdown, 'utf8') > 2048);
  const tool = host.tools.get('qq_memory');
  await tool.execute({ action: 'write', path: 'conversations/private-100000002/MEMORY.md', text: markdown }, { agent });
  await until(
    () => host.list.warnings.some((warning) => warning.includes('could not write archive/')),
    'the rollover failure to be reported',
  );
  const hot = await readMemory(cwd, 'conversations/private-100000002/MEMORY.md');
  assert.equal(hot.split('\n').filter((line) => /^- /.test(line.trim())).length, 40, '归档失败时热层一条都不能少');
  assert.equal(await readFile(join(convDir, 'archive'), 'utf8'), 'blocked', '占位文件本身不该被改');
});


/** PEOPLE.md 首次为空时从各群 MEMORY.md 的「## 人」小节抽取（一次性、幂等、只补不覆盖）。 */
test('PEOPLE.md is seeded once from conversation MEMORY.md person sections', async () => {
  const { cwd } = await bootMemory({}, {}, {}, async (root) => {
    const dir = join(root, '.qq-memory', 'conversations', 'group-100000001');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'MEMORY.md'),
      '# 群记忆\n\n## 人\n- kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本｜首见 2026-10-12\n- iroha｜爱看展的群友\n',
      'utf8',
    );
  });
  const people = await until(async () => {
    try {
      return await readMemory(cwd, 'PEOPLE.md');
    } catch {
      return undefined;
    }
  }, 'PEOPLE.md to be seeded at startup');
  assert.match(people, /kaguya（QQ 100000001）（别名：soyo）｜群主，周六常组织打本/);
  assert.match(people, /iroha｜爱看展的群友/);
  assert.equal(people.split('\n').filter((line) => line.startsWith('- kaguya')).length, 1, '迁移必须幂等：一人一行');
});


/** memoryDir 配到 cwd 外面时整个功能停用（与 mediaDir / stickerDir 一致）。 */
test('memory is disabled when memoryDir leaves cwd', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'qq-bridge-outside-'));
  // 这条用例断言的是「一个周期定时器都不该挂」：API key 轮换的定时器与记忆无关
  // （它默认开着），显式关掉才数得清记忆这一侧。
  const { onebot, host } = await bootMemory({ memoryDir: join(outside, 'memory'), apiKeyRotate: false });
  onebot.push(privateMessage('你好'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  assert.equal(host.tools.get('qq_transcript'), undefined);
  assert.equal(host.tools.get('qq_memory'), undefined);
  assert.equal(host.list.timers.live('intervals').length, 0);
  assert.ok(
    host.list.warnings.some((warning) => warning.includes('resolves outside cwd')),
    `expected a warning, got: ${host.list.warnings.join(' | ')}`,
  );
});


/**
 * 摘要卡住时不能把摘要永久堵死：硬超时到点就销毁那个 Agent，下次重新开一个。
 *
 * 这里让 `whenIdle()` 永不 resolve（模拟一个卡死的模型请求），然后手动让超时守卫醒来。
 */
test('a digest that never goes idle is given up on and cleaned up', async () => {
  const { onebot, host, cwd } = await bootMemory({ digestMinLines: 1 });
  // 让这个实例的每个 Agent 都「永不结束这一轮」。
  host.list.stallIdle = true;
  onebot.push(privateMessage('帮我看个东西'));
  await until(() => host.list.created[0], 'the conversation Agent to be created');
  host.list.timers.fireInterval();
  await until(() => host.list.timers.live('timeouts').length > 0, 'the digest timeout guard to be armed');

  host.list.timers.fireTimeout();
  await until(
    () => host.list.warnings.some((warning) => warning.includes('timed out')),
    'the digest to report its timeout',
  );
  await settle(80);
  // 超时的这次不算数：状态里不该留下 lastDigestAt（下一轮还会再试），而被销毁的
  // 摘要 Agent 已经不在 ctx.agents 里了。
  const state = await readMemory(cwd, 'digest.json').then((text) => JSON.parse(text)).catch(() => ({ conversations: {} }));
  assert.equal(state.conversations['private:100000002']?.lastDigestAt, undefined);
  const digestAgent = host.list.created[1];
  assert.ok(digestAgent, 'the digest session should have been created');
  assert.equal(host.ctx.agents.get(digestAgent.id), undefined, 'the stuck digest agent should have been disposed');
});
