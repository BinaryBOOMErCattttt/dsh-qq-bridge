# 交接文档（服务器 → 本机）

## 这是什么

这是 `flyinstar/dsh-qq-bridge` 的**已脱敏功能分支**，从服务器运行版导出。目标：带回本机，
先 fork 上游，再把这份代码覆盖进 fork，之后在本机维护。

- 上游：<https://github.com/flyinstar/dsh-qq-bridge>（MIT）
- 环境：DSH 插件，Node ≥22，纯 ESM，零运行时 npm 依赖
- 不含：人设、记忆、表情、`data/`、`.env`、NapCat、`node_modules`、日志
- 已脱敏：个人昵称、QQ 号、群号、部署激活词、表情容量、主动说话节奏

## 改动清单

1. **指令系统**：`commands.js`；`@bot + 空格 + 指令`，私聊免 @；分「玩 / 查 / 聊 / 管」。
   零 token：帮助、天气、随机表情、状态、余额、设置、抽签、吃饭、饭量、敲木鱼、群热度、
   骰子、硬币、点名、点歌、接一个、投票、关注、纪念日、复读开关、存表情、定档、语音。
   走模型：表情、白饭、小作文、看图、总结链接、梗、日报、记忆、提醒。
2. **模块**：`fun.js`（运势/骰子/硬币）、`chat-state.js`（`data/chat-state.json` 原子写）、
   `music.js`（网易云搜索，只贴链接）、`owner-settings.js`（覆盖层）、`editor.js`（受信写盘）。
3. **定档**：`定档` 主人指令；写 `data/handoff/*.md`（最近 80 条 + 任务关键词 + 状态），
   会话代次 +1，旧会话移到 `data/handoff/archive/`，新 Agent 先 `read` 文档再确认。
   主人说「睡觉去 / 去睡吧 / 休眠 / 静默 / 该睡了」后 12 秒未静默，自动兜底。
4. **图文与攒批**：`mediaHoldMs`（默认 1500）把图 + 配文攒进同一轮；硬规则要求先
   `read_image`；`batchWindowMs` 默认 2000（服务器覆盖 5000，不进默认）。
5. **并发修复**：`ensureAgent` 用 `agentsInFlight` 合并同 sessionId 的并发 create；
   撞 `already exists` 时复用 live / 再 resume。
6. **TTS**：`tts.js` 是**纯框架**，只提供 `registerTtsProvider()` / `synthesize()`；
   仓库不内置 Edge-TTS / Azure / 任何在线语音 API。未注册 provider 时 `语音` 只回
   「未配置」，不会联网。
7. **其它**：群成员进出文案、关注词私聊通知、纪念日、投票条形图；点歌不做卡片
   （`music` 段被 NapCat 拒、Ark 卡片显示「发送者版本过低」）。

## 本机操作

1. 打开 <https://github.com/flyinstar/dsh-qq-bridge>，点 **Fork**。
2. `git clone https://github.com/<你的账号>/dsh-qq-bridge.git`
3. 把 zip 解压后的**内容**覆盖进克隆目录，保留 `.git/` 和上游 `LICENSE`。
4. `git status --short` 确认没有 `.env` / `.qq-*` / `data/` / `NapCat.Shell` / `node_modules` / `*.log`。
5. 跑测试；提交、push。

## 给本机 AI 的交接提示词（直接复制）

```text
我在本机 fork 了 https://github.com/flyinstar/dsh-qq-bridge（MIT），
并带来了一份从服务器运行版导出的、已脱敏的功能分支（zip）。
请按下面做，不要跳过检查：

1. 先读 HANDOFF.md、FORK.md、README.md、docs/commands.md，理解这是 DSH 的 QQ 插件，
   Node ≥22、纯 ESM、零运行时依赖；测试用 node:test。
2. 把我解压出来的文件覆盖进 fork 工作区（保留 .git/ 和上游 LICENSE）。
   不要覆盖/提交：.env、.qq-persona/、.qq-memory/、.qq-stickers/、.qq-media/、
   data/、NapCat.Shell/、node_modules/、*.log、dist/。
3. 用 git diff 对照上游，确认改动集中在：
   commands.js、fun.js、chat-state.js、music.js、tts.js、owner-settings.js、
   index.js、tools.js、config.js、settings.js、client.js、docs/、test/。
   检查有没有把个人 QQ 号、群号、昵称、真实路径写进代码或文档。
4. 保留上游 MIT LICENSE 与原版权声明；我要另加授权的话会自己写 NOTICE/README，
   你不要删掉上游版权。
5. 跑测试。Windows 上测试前需要把 DSH 宿主的 node_modules 拷进插件目录：
   $env:ELECTRON_RUN_AS_NODE='1'
   & '<DSH NEXT.exe>' 'copy-asar-modules.mjs'
   然后：
   node --test --experimental-test-isolation=none 'test/*.test.mjs'
   预期：除 desktop.test.mjs 的 Windows junction 用例外全绿；该用例是环境问题。
   跑完删掉 node_modules，别提交。
6. TTS 只保留框架：仓库不内置任何在线语音 API（没有 Edge-TTS / Azure）。
   如果我要接本地 TTS，就在 tts.js 里 registerTtsProvider('default', ...)，
   不要提交模型文件、解释器路径或第三方服务密钥。
7. 最后给我：diff 摘要、测试结果、仍需我确认的配置项（resetUsers、群白名单、
   persona、TTS provider），不要直接 push，等我确认。
```

## 测试与环境

- `node --test --experimental-test-isolation=none 'test/*.test.mjs'`
- 基线：**682 条，681 过**；唯一失败是 `desktop.test.mjs` 的 Windows junction 用例
  （机器环境问题，备份代码同样失败）。
- Windows 测试前从 DSH 的 `app.asar` 拷 `node_modules`；运行服务前移除。

## 配置默认值

- `groupTrigger: mention`，`prefix: /`
- `stickerMaxFiles: 60`
- 主动说话：10 分钟检查 / 安静 45 分钟 / 间隔 2 小时 / 每天 4 次 / 概率 0.35
- `tts: false`（只留框架，未注册 provider 时不会联网）
- `mediaHoldMs: 1500`；`batchWindowMs: 2000`
- 主人 QQ 读 `QQBOT_RESET_USERS`，不写死
- 不含 `PERSONA.md` / `STYLE.md`，用内置回退；部署时从 `deploy/persona/` 复制模板

## 已知取舍

- 点歌只贴链接：不做音频下载/转发（版权），不做卡片（NapCat/QQ 不支持）。
- 语音只留框架：不内置在线语音服务，避免第三方 API 的条款/版权问题。
- 自动语音未实现：目前只有手动 `语音 <文字>`。
- 定档会丢当前 DSH 会话上下文（目的），长期记忆仍在 `.qq-memory/`。
