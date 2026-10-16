# 更新记录

版本号按[语义化版本](https://semver.org/lang/zh-CN/)走。0.x 阶段配置项与行为都可能变，
每次改动以 `Config` 的 schema 与 README 为准。

## 0.1.1 — 2026-10-15

修 Windows 桌面版**安装流程**里实测出来的三处毛病。都在「NapCat 那一侧」，与 QQ 会话链路无关。

**一键配置现在认得出刚解压的 NapCat**

- 之前只认「`config/onebot11_<QQ号>.json` 已经存在」的目录 —— 而那个文件是 **NapCat 登录之后**
  才生成的。发布版安装流程恰恰是「解压 → 立刻跑脚本」，于是脚本回一句「没找到 NapCat 安装
  目录」，`--qq` 那条「先把骨架配置写好、登录后即可用」的路永远走不到（实测踩过：仓库根下
  明明躺着一份 `NapCat.Shell`）。
- 现在多一条弱判据：目录里有 NapCat 自带的启动件（`launcher*.bat` / `launcher-elevate.ps1` /
  `napcat.mjs` / `loadNapCat.js` / `NapCatWinBootMain.exe`）也算（`looksLikeNapcatShell`）；
  强判据（有账号配置）仍然优先。插件启动自检与脚本共用这条判据，所以两边的结论不会打架。

**快速登录：不用每次掏手机扫码**

- `--qq <号>` 现在顺便把 `<NapCat>\config\webui.json` 的 `autoLoginAccount` 设成这个号，
  NapCat 以后启动就自己快速登录。只动那一个字段、改前备份、幂等（已经对了连备份都不产生）；
  `webui.json` 还不存在（NapCat 没启动过）时**不凭空造**它 —— 那会把它 WebUI 的 host / port /
  token 一起抹掉，而是提示你登录完再跑一次。不想要这条加 `--no-auto-login`。
- 前提是本机已经为这个号留下过登录记录；没有记录时 NapCat 会退回二维码，那不是失败 ——
  扫一次码，之后才会走快速登录。

**启动 NapCat 必须提权（原来会崩）**

- `--start` 原来用 `cmd /c start` 拉起 `launcher-user.bat` —— 那是包里**刻意不提权**的变体。
  实测（QQ 9.9.35-52892 + NapCat 4.18.38）：不提权时注入其实**成功**（崩溃转储的模块列表里
  能看到 `NapCatWinBootHook.dll` 已加载、QQ 的 Node 运行时 `major.node` 也在），但 QQ 随后在
  `QQNT.dll` 里撞 `0x80000003`（STATUS_BREAKPOINT）当场死掉，控制台只剩一句 `Process exited.`；
  提权启动一切正常。而 NapCat 自己的兼容表与 `qqnt.json` 都覆盖这个 QQ build、QQ 安装目录也
  干净，所以这不是「版本不支持」。
- 现在改走官方文档让用户双击的 `launcher.bat`（会自己提权），并把 `--qq` 当 `-q <号>` 传给
  NapCat 做快速登录；提权方式是我们自己 `Start-Process -Verb RunAs`（命令走 Base64，
  路径里有空格/中文也不会被引号转义拆坏）。
- 新增 `--window normal|min|hidden`（默认 `min`）。那个控制台窗口就是 NapCat 本体，**关掉它
  等于停掉机器人**；`hidden` 适合已经能自动快速登录、不想看见窗口的机器。首次登录要扫码，
  得用 `normal` / `min`。

**不要那个黑框框：`--autostart install`（计划任务 + 无窗口 + 免 UAC）**

- 原来 `--window hidden` 只是把窗口样式交给 `Start-Process`，而 `launcher.bat` 在非管理员时
  会用 `launcher-elevate.ps1` 把 **`wt.exe`（Windows Terminal）** 提权起来重跑自己 ——
  Windows Terminal 没有「隐藏启动」这回事，那个窗口一定会出现。现在 `hidden` 换了一条路：
  提权跑 `wscript.exe`（GUI 宿主，自己不带控制台），由它用 `WshShell.Run` 的窗口样式 `0`
  起 `cmd.exe /s /c "launcher.bat" -q <号>`，控制台从创建那一刻就是隐藏的。
- 新增 `--autostart install|remove|status`：注册一个计划任务（`dsh-qq-bridge-napcat`），
  **登录时以最高权限、无窗口**启动 NapCat。装的时候点一次 UAC，以后启动不再问、也没有窗口
  （`RunLevel: HighestAvailable` + `LogonType: InteractiveToken` + `IgnoreNew` + `PT0S`；
  为什么是这几个值写在 `scheduledTaskXml` 上）。任务 XML 与包装脚本放在 NapCat 目录里，
  跟着它一起删；`--autostart status` 能看上次跑成没成。
- 装计划任务时顺手把 NapCat 日志改成写文件（`consoleLog=false` / `fileLog=true`，先备份、
  幂等、`--no-log-to-file` 可关）：窗口看不见了，日志是唯一的现场。脚本还会把 WebUI 的地址与
  token（从 `config/webui.json` 读，原本是打在控制台里的）打出来 —— 看日志、扫码登录、改配置
  都在那儿，所以隐藏启动也不影响第一次登录。
- 三个都是实测踩出来的细节，注释里写了理由：`wscript.exe` 必须带 **`//B`**（不加时 WSH 一出错
  就弹一个看不见的模态错误框卡住：本地实测同一份脚本加 `//B` 跑通、不加就卡住等点）；命令行走
  `cmd.exe /s /c` 而不是把 `.bat` 直接交给 `WshShell.Run`（后者走文件关联，zip 解压出来的
  `.bat` 带 Mark-of-the-Web，会弹「打开文件 - 安全警告」）；包装脚本按 **UTF-16LE + BOM**
  落盘（WSH 读无 BOM 脚本按 ANSI 解码，中文注释与中文路径会乱码）。另外
  `Start-Process -ArgumentList` 收数组时**不会**替参数加引号，带空格的路径要自己带引号
  （`hiddenStartPlan` 的用例钉住了这条）。
- `--autostart install` 在 `config/webui.json` 还不存在时（这份 NapCat 从没启动过）会拦住：
  那时既没有二维码可看、WebUI 也没生成，隐藏启动等于把自己关在门外；`--force` 可跳过。

- 插件启动自检现在分得清「目录配错了」（warn）与「这份 NapCat 还没登录过」（info）：后者是
  发布版安装流程里的正常中间态，日志会直接给出下一步（`inspectNapcat` / `repairNapcat` 新增
  结构化的 `noAccount` 标记，不靠文案匹配 —— 以前那种情况会记一句「自检没跑成」，吓人且没用）。

**测试**

- `test/napcat.test.mjs` 从 11 条加到 14 条：新增 `looksLikeNapcatShell`（弱判据的边界）、
  `withAutoLoginAccount`（只动一个字段 / 幂等 / 不凭空清空）、`startPlan`（必须 `-Verb RunAs`、
  三种窗口样式、认不出的取值按默认、换平台或缺启动器时给一句人话）三组用例，
  以及 `noAccount` 这条结构化信号的正反两面。
- 顺手修掉 `test/bridge.test.mjs` 里 **23 处「只等 Agent 就断言收件箱」的竞态**：假 Host 的
  `create()` 是**如实照搬真宿主**的 —— Agent 先造出来并记进 `created`，消息由插件在**之后**
  才 `agent.followup(...)` 投进去，20ms 的轮询会偶尔抢在投递之前（本机跑全量时抓到三处不同的
  用例翻车，其中「群 @ 那条」单独跑都能稳定复现，症状是 `inbox[0]` 为 undefined、
  `completeTurn` 拿着 `message: undefined` 去开 turn）。这 23 处现在统一走新的
  `untilInbox(host, n)`；只关心「创建了几个 Agent」的用例仍然直接用
  `until(() => host.list.created[0], …)`。
- 用例总数 304 → 307；**全量连跑三遍全绿**。

## 0.1.0 — 2026-10-15

首个公开版本：把 QQ（OneBot v11，NapCat / Lagrange / go-cqhttp）接到 DeepSeek Harness 上。

**双向链路**

- QQ 私聊、群里被 @ 的消息 → 一个持久化的 DSH Session。Session id 由会话 key 经 SHA-256
  **确定性**派生，Harness 重启后同一个人再发消息会 `resume` 原有会话，聊天记忆不丢。
- 回复取该轮里**最后一条有文本的** assistant 消息，中间步骤的工具调用不发 QQ；
  `aborted` / `forked` / `interrupted` 静默丢弃，出错回一句固定道歉。
- 任何 DSH Agent（包括 Web UI 里的主会话）都能用 `qq_send_message` / `qq_send_image`
  主动发消息、发图。
- 前后脚到的消息先攒一个窗口（`batchWindowMs`，默认 1.2 秒）再投给 Agent：几个人同时 @
  它，一轮里一起接住。回复换行即分条、按打字节奏发出、引用被回复的那条；
  写 `[[@昵称]]` 发出去是真正的 @ 而不是一串 QQ 号。

**表情包**

- 会挑表情包发；**整条回复只写一行标记时，只发一张表情、一个字都不说**。
- `qq_save_sticker` 把别人刚发的那张存进 `.qq-stickers/`：只允许写该目录内、
  文件名洗成单层、张数受上限约束（QQ 侧唯一能写盘的能力，边界见 README）。

**自动复读（不经过模型、不建会话）**

- 群里连着出现同一条消息时跟一句；连着两张一样的表情包时把那张原样发回去。
- 图片判「同一张」留了两层：字节完全相同只是快路；QQ 会把同一张表情包按发送者重新编码
  （实测同一张有 94657B / 131307B / 79284B 三种形态），所以第二层是 16×16 灰度的画面
  指纹（dHash），只比字节的话这一整块在真实群里永远不触发。指纹懒算并按路径缓存。

**像真人一样说话**

- 拆句、打字延迟、抖动、频率上限、活跃时段（`withinActiveHours`，支持跨零点）。
- **主动说话**（`proactive`，默认关）：群里冷下来之后，插件往该群自己的会话里伪造一条
  带 `SKIP` 出口的提醒，让它带着环境上下文与长期记忆自己想一句 —— 一次醒来最多一个群，
  掷中即消耗当天额度。冷场管「主动」，这一块管「不做独白」。
- **活跃对话**（`activeFollow` 默认关）：聊起来之后不必每句都 @。一对一的免 @ 接话、
  群里够条数够人数之后的**多人搭话**（累计概率抽卡，抽不中就继续听，倾听时间与攒批
  窗口同倍放大）、以及「回完对方安静一会儿再补一句」。活跃窗口只靠别人发来的消息往后滑 ——
  否则机器人自己就能给窗口续命。

**长期记忆**

- 每条消息落盘成转录；每天定时由一个**独立摘要会话**把它整理成「这个群记得什么」
  （`MEMORY.md`），顺带用 `update-cognition` skill 学会群里的梗，看不懂的二次元梗先走
  `moegirl` skill 查萌娘百科。
- 聊天时用 `qq_transcript` / `qq_memory` 查。摘要**成功之后才推进日期**，所以摘要是后台
  会话、被压缩或重启都不影响记忆，没跑成也不会把消息算丢。

**运维**

- `/reset` 开新一轮会话：换一个确定性的 Session id 从头开始，旧会话留在磁盘上存档，
  代次**落盘**（只在内存里的话重启会把上一轮 resume 回来）。默认谁都不能用
  （`resetUsers` 空 = 全关，与 `allowUsers` 的语义相反）。
- 每天 04:00 从 `data/api-keys.txt` 里挑下一个**探测通过**的 key，经 `ctx.credentials`
  写进凭据文件，当场生效不用重启；池子不存在、没有第二个能用的、或 key 来自启动环境时
  什么都不做（宁可不动也不能把 bot 换成不可用的状态）。
- 两种部署都有一手：Linux 容器 + systemd（`deploy/qqbot.service`，`Restart=always`）；
  Windows 桌面版（`scripts/napcat-setup.mjs` 把 NapCat 的 WebSocket 配置、profile 的
  `.env`、desktop profile 的依赖与 bundles 一次配好，幂等 + 先备份，可 `--dry-run`）。

**在 Web UI 里改配置**

- 侧栏 **设置 → QQ Bridge**：一百多个配置项做成**单独一页**，按十几张折叠卡片分组
  （默认只展开第一组，组名右边的记号是「这一组改过几项」）。字段来自 `config.js` 的
  schema、标签与说明来自 `.description()`，所以**加了新配置项页面自动多一行**；
  `persona` / `instructions` 是整段提示词，单独一张卡片、用多行输入框改。
  `accessToken` 这类秘密不下发（只告诉你「配了 / 没配」）。原先只能手写
  `cordis.patch.yml`，而「只写几个字段」的那种写法会把整套配置整块顶掉。
- 保存写的是**当前 profile 的完整 config**，`!!js` 表达式原样保留 —— 从环境变量读的
  `endpoint` / `resetUsers` 不会因为点了一次保存就变成写死的字面量。保存之后插件会
  自动重启一次（配置走 volatile 热更新，而连接、定时器、工具注册都是 `apply()` 里装配的）：
  断一次 OneBot 连接，**聊天记忆不受影响**（会话 id 是确定性的，下一条消息照样 resume）。
- 浏览器半侧是手写的 `client.js`（`window.__ModuleLoader__.load({...})` bundle，本仓库
  没有构建步骤），契约由 `test/client.test.mjs` 钉住：字段全覆盖、分组不漏、折叠默认只
  展开第一组、布尔 / 逗号列表 / 枚举三种草稿的读写口径。

**工程**

- 零运行时依赖：只用 Node 全局 `WebSocket` / `fetch` / `node:*`，OneBot v11 客户端是手写的。
- 纯 ESM，Node ≥ 22，无构建步骤，改完即用；类型信息全写在 JSDoc 注释里。
- 304 条测试用例：真实插件模块 + 真实 OneBot 客户端 + 假 OneBot 服务端 + 假 Harness ctx
  （含假 timer），跑完整的入站 → Agent → 出站往返；设置页那半侧用假的 `window.__ModuleLoader__`
  与假 `useState` 跑，不需要浏览器。

**已知限制**

- 面向个人自用，不保证开箱即用：需要自己装好 DSH，模型凭据在 Web UI 的 Models 页填一次。
- QQ 消息按**不可信输入**处理：默认 `approvalPolicy: 'never'`、群消息默认只在被 @ 时触发、
  `/reset` 默认谁都不能用。`allowTools` 再收一层 QQ 会话能用的工具。
- `jm.js` 那条旁路（`/jm` 下载漫画转 PDF 发回会话）需要 Python 与它自己的依赖，
  与上面的 QQ 链路彼此独立。
