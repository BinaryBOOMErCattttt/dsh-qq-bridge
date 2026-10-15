# 更新记录

版本号按[语义化版本](https://semver.org/lang/zh-CN/)走。0.x 阶段配置项与行为都可能变，
每次改动以 `Config` 的 schema 与 README 为准。

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

**工程**

- 零运行时依赖：只用 Node 全局 `WebSocket` / `fetch` / `node:*`，OneBot v11 客户端是手写的。
- 纯 ESM，Node ≥ 22，无构建步骤，改完即用；类型信息全写在 JSDoc 注释里。
- 288 条测试用例：真实插件模块 + 真实 OneBot 客户端 + 假 OneBot 服务端 + 假 Harness ctx
  （含假 timer），跑完整的入站 → Agent → 出站往返。

**已知限制**

- 面向个人自用，不保证开箱即用：需要自己装好 DSH，模型凭据在 Web UI 的 Models 页填一次。
- QQ 消息按**不可信输入**处理：默认 `approvalPolicy: 'never'`、群消息默认只在被 @ 时触发、
  `/reset` 默认谁都不能用。`allowTools` 再收一层 QQ 会话能用的工具。
- `jm.js` 那条旁路（`/jm` 下载漫画转 PDF 发回会话）需要 Python 与它自己的依赖，
  与上面的 QQ 链路彼此独立。
